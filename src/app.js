const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { z } = require('zod');
const db = require('./db');
const config = require('./config');
const { ROLES, MODULES } = require('./constants');
const {
  attachUser,
  requireLogin,
  requireRole,
  loadAuthorizedEvent,
  isAdmin,
  isManager,
  canViewEventFile,
  canDownloadEventFile,
  canEditEventContent,
  canReviewEventContent,
  canDeleteEventFile,
} = require('./middleware/auth');
const { csrf } = require('./middleware/csrf');
const { audit } = require('./utils/audit');
const { sendMail } = require('./utils/email');
const { hashPassword, verifyPassword, makeToken, hashToken } = require('./utils/security');
const { moduleCompletion } = require('./utils/completion');
const { esc, layout, authPage, eventHeader, table, optionList } = require('./ui');
const { loadSettings, setSetting } = require('./services/settings');
const { initModules, loadModuleStatuses, markLoaded } = require('./services/events');
const { notifyEventOwner, reviewNotificationMessage } = require('./services/notifications');
const { upload, saveAttachment, resolveAttachment } = require('./services/storage');
const { workbookTemplateBuffer, parseStaff } = require('./services/excel');
const { modulePdf } = require('./services/pdf');
const { streamEventZip } = require('./services/zip');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 500 }));
app.use(session({
  store: new PgSession({ pool: db.pool, createTableIfMissing: true }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.sessionSecure, maxAge: 1000 * 60 * 60 * 8 },
}));
app.use(attachUser);
app.use(csrf);
app.use(async (req, res, next) => {
  if (!req.user) return next();
  try {
    const unread = await db.query('select count(*) count from notifications where user_id=$1 and read_at is null', [req.user.id]);
    req.user.unread_notifications = Number(unread.rows[0].count);
    next();
  } catch (error) {
    next(error);
  }
});
app.use(async (req, res, next) => {
  if (!app.locals.portalSettings) await loadSettings(app);
  next();
});

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  return parsed.data;
}

app.get('/branding/logo', async (req, res) => {
  const file = (await db.query(
    `select a.* from system_settings s
     join attachments a on a.id::text=s.value
     where s.key='logo_attachment_id' and a.event_id is null and a.deleted_at is null`,
  )).rows[0];
  if (!file || !String(file.mime_type).startsWith('image/')) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-store');
  res.type(file.mime_type);
  fs.createReadStream(resolveAttachment(file)).pipe(res);
});

app.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'));
app.get('/login', (req, res) => res.send(authPage(req, 'login')));
app.get('/register', (req, res) => res.send(authPage(req, 'register')));
app.get('/forgot', (req, res) => res.send(authPage(req, 'forgot')));

app.post('/register', async (req, res) => {
  try {
    const data = parseBody(z.object({
      first_name: z.string().min(1), last_name: z.string().min(1), email: z.string().email(), phone: z.string().optional(),
      username: z.string().min(3), password: z.string().min(8), confirm_password: z.string().min(8),
    }).refine((v) => v.password === v.confirm_password, 'Las contrasenas no coinciden'), req.body);
    const exists = await db.query('select 1 from users where email=$1 or username=$2', [data.email, data.username]);
    if (exists.rowCount) throw new Error('Email o usuario ya registrado');
    const passwordHash = await hashPassword(data.password);
    const user = await db.tx(async (client) => {
      const created = await client.query(
        `insert into users (first_name,last_name,email,phone,username,password_hash,status)
         values ($1,$2,$3,$4,$5,$6,'PENDIENTE') returning *`,
        [data.first_name, data.last_name, data.email, data.phone || null, data.username, passwordHash],
      );
      await client.query(`insert into user_roles (user_id, role_id) select $1, id from roles where name='PRODUCTOR'`, [created.rows[0].id]);
      return created.rows[0];
    });
    await audit(user.id, 'registro', 'users', user.id, { email: user.email });
    await sendMail(user.email, 'Registro recibido', 'Tu cuenta fue recibida y requiere aprobacion administrativa.');
    flash(req, 'ok', 'Registro recibido. Tu cuenta requiere aprobacion administrativa.');
    res.redirect('/login');
  } catch (error) {
    flash(req, 'error', error.message);
    res.redirect('/register');
  }
});

app.post('/login', async (req, res) => {
  const result = await db.query(
    `select u.*, array_remove(array_agg(r.name), null) roles from users u
     left join user_roles ur on ur.user_id=u.id left join roles r on r.id=ur.role_id
     where u.email=$1 or u.username=$1 group by u.id`,
    [req.body.login],
  );
  const user = result.rows[0];
  if (!user || !(await verifyPassword(req.body.password || '', user.password_hash))) {
    flash(req, 'error', 'Credenciales invalidas');
    return res.redirect('/login');
  }
  if (user.status !== 'ACTIVO') {
    flash(req, 'error', `Cuenta ${user.status.toLowerCase()}.`);
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  await audit(user.id, 'login', 'users', user.id);
  res.redirect('/dashboard');
});

app.post('/logout', requireLogin, async (req, res) => {
  await audit(req.user.id, 'logout', 'users', req.user.id);
  req.session.destroy(() => res.redirect('/login'));
});

app.post('/forgot', async (req, res) => {
  const user = (await db.query('select * from users where email=$1', [req.body.email])).rows[0];
  if (user) {
    const token = makeToken();
    await db.query('insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1,$2,now()+interval \'1 hour\')', [user.id, hashToken(token)]);
    await sendMail(user.email, 'Recuperacion de contrasena', `Use este enlace para cambiar su contrasena: ${config.appUrl}/reset/${token}`);
  }
  flash(req, 'ok', 'Si el email existe, enviamos instrucciones de recuperacion.');
  res.redirect('/login');
});

app.get('/reset/:token', (req, res) => res.send(layout(req, 'Cambiar contrasena', `<form method="post" class="panel form-stack">
  <input type="hidden" name="_csrf" value="${req.csrfToken}"><label>Nueva contraseña<input type="password" name="password" required minlength="8"></label><button class="primary">Cambiar</button></form>`, { narrow: true })));

app.post('/reset/:token', async (req, res) => {
  const tokenHash = hashToken(req.params.token);
  const row = (await db.query('select * from password_reset_tokens where token_hash=$1 and used_at is null and expires_at>now()', [tokenHash])).rows[0];
  if (!row) { flash(req, 'error', 'Token invalido o vencido'); return res.redirect('/forgot'); }
  await db.tx(async (client) => {
    await client.query('update users set password_hash=$1, updated_at=now() where id=$2', [await hashPassword(req.body.password), row.user_id]);
    await client.query('update password_reset_tokens set used_at=now() where id=$1', [row.id]);
  });
  flash(req, 'ok', 'Contrasena actualizada.');
  res.redirect('/login');
});

app.get('/dashboard', requireLogin, async (req, res) => {
  if (isAdmin(req.user)) return res.redirect('/admin');
  const events = isManager(req.user)
    ? await db.query(`select e.* from events e join event_manager_access a on a.event_id=e.id where a.user_id=$1 order by e.created_at desc`, [req.user.id])
    : await db.query('select * from events where owner_user_id=$1 order by created_at desc', [req.user.id]);
  const cards = events.rows.map((e) => `<article class="event-card"><h2>${esc(e.name)}</h2><p>${esc(e.artist)} · ${esc(e.venue)}</p><p>${esc(e.city)}, ${esc(e.province)}</p><span class="badge">${esc(e.status)}</span><a class="primary" href="/events/${e.id}">Abrir</a></article>`).join('');
  res.send(layout(req, 'Mis eventos', `<section class="toolbar"><div><h1>${isManager(req.user) ? 'Eventos autorizados' : 'Mis eventos'}</h1><p>Entrar, abrir evento, elegir modulo, cargar y guardar.</p></div>${!isManager(req.user) ? '<a class="primary" href="/events/new">+ Crear Evento</a>' : ''}</section><section class="cards">${cards || '<p class="empty">No hay eventos.</p>'}</section>`));
});

app.get('/events/new', requireLogin, requireRole(ROLES.PRODUCER), (req, res) => res.send(layout(req, 'Crear evento', `<form method="post" action="/events" class="panel form-grid">
  <input type="hidden" name="_csrf" value="${req.csrfToken}">
  ${['Nombre del evento:name','Artista:artist','Fecha del show:show_date','Lugar / Venue:venue','Ciudad:city','Provincia:province'].map((x)=>{const [l,n]=x.split(':'); return `<label>${l}<input name="${n}" ${n==='show_date'?'type="date"':''} required></label>`}).join('')}
  <label class="span">Fechas adicionales<textarea name="extra_dates" placeholder="Una fecha por linea, formato AAAA-MM-DD"></textarea></label>
  <button class="primary span">Crear Evento</button></form>`)));

app.post('/events', requireLogin, requireRole(ROLES.PRODUCER), async (req, res) => {
  const data = parseBody(z.object({ name:z.string().min(1), artist:z.string().min(1), show_date:z.string().min(1), venue:z.string().min(1), city:z.string().min(1), province:z.string().min(1), extra_dates:z.string().optional() }), req.body);
  const event = await db.tx(async (client) => {
    const created = await client.query(`insert into events (owner_user_id,created_by,name,artist,venue,city,province) values ($1,$1,$2,$3,$4,$5,$6) returning *`, [req.user.id, data.name, data.artist, data.venue, data.city, data.province]);
    const dates = [data.show_date, ...(data.extra_dates || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)];
    for (const d of dates) await client.query('insert into event_dates (event_id, show_date) values ($1,$2)', [created.rows[0].id, d]);
    await initModules(client, created.rows[0].id);
    return created.rows[0];
  });
  await audit(req.user.id, 'crear_evento', 'events', event.id);
  res.redirect(`/events/${event.id}/modules/identificacion`);
});

app.get('/events/:eventId', requireLogin, loadAuthorizedEvent, (req, res) => res.redirect(`/events/${req.event.id}/modules/identificacion`));

async function rowsForModule(eventId, key) {
  const map = {
    seguros: ['Tipo','Vigencia','Observacion','Archivo'], 'habilitaciones': ['Tipo','Numero','Observacion','Archivo'], servicios: ['Categoria','Prestador','Observacion','Archivo'],
    prensa: ['Categoria','Observacion','Archivo'], tecnica: ['Categoria','Observacion','Archivo'], sponsors: ['Marca','Acuerdo','Descripcion','Archivo'],
  };
  return map[key] || [];
}

app.get('/events/:eventId/modules/:moduleKey', requireLogin, loadAuthorizedEvent, async (req, res) => {
  const key = req.params.moduleKey;
  const canEdit = canEditEventContent(req.user, req.event);
  await loadModuleStatuses(req.event);
  const company = (await db.query('select * from event_companies where event_id=$1', [req.event.id])).rows[0] || {};
  const files = await db.query('select * from attachments where event_id=$1 and module_key=$2 and deleted_at is null order by created_at desc', [req.event.id, key]);
  const statusHistory = await db.query('select h.*, u.first_name, u.last_name from module_status_history h left join users u on u.id=h.created_by where event_id=$1 and module_key=$2 order by created_at desc limit 20', [req.event.id, key]);
  let content = '';
  if (key === 'identificacion') {
    const staff = await db.query('select * from event_staff where event_id=$1 order by created_at desc', [req.event.id]);
    const staffTable = table(['Nombre','CUIT','Cargo','Empresa'], staff.rows.map((p)=>`<tr><td>${esc(p.first_name)} ${esc(p.last_name)}</td><td>${esc(p.cuit)}</td><td>${esc(p.role_title)}</td><td>${esc(p.company)}</td></tr>`));
    content = canEdit ? `<form method="post" action="/events/${req.event.id}/modules/identificacion/company" class="panel form-grid">
      <input type="hidden" name="_csrf" value="${req.csrfToken}">
      ${[['Razón Social','legal_name'],['CUIT','cuit'],['Responsable','responsible'],['Teléfono','phone'],['Email','email']].map(([l,n])=>`<label>${l}<input name="${n}" value="${esc(company[n])}"></label>`).join('')}
      <button class="primary span">Guardar identificación</button></form>
      <section class="panel"><div class="toolbar"><h2>Personal del Evento</h2><div><a class="button" href="/events/${req.event.id}/staff/template">Descargar plantilla Excel</a></div></div>
      <form method="post" enctype="multipart/form-data" action="/events/${req.event.id}/staff/import?_csrf=${req.csrfToken}" class="upload-form"><input type="file" name="file" accept=".xlsx,.xls,.csv" required><button>Subir Excel</button><progress hidden max="100"></progress></form>
      <form method="post" action="/events/${req.event.id}/staff" class="inline-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">${['first_name:Nombre','last_name:Apellido','cuit:CUIT','role_title:Función / Cargo','company:Empresa','phone:Teléfono','email:Email'].map((x)=>{const [n,l]=x.split(':'); return `<input name="${n}" placeholder="${l}" ${['first_name','last_name','cuit','role_title'].includes(n)?'required':''}>`}).join('')}<button>+ Agregar persona</button></form>
      ${staffTable}</section>` : `<section class="readonly-details"><div><small>Razon social</small><b>${esc(company.legal_name || 'Sin completar')}</b></div><div><small>CUIT</small><b>${esc(company.cuit || 'Sin completar')}</b></div><div><small>Responsable</small><b>${esc(company.responsible || 'Sin completar')}</b></div><div><small>Telefono</small><b>${esc(company.phone || 'Sin completar')}</b></div><div><small>Email</small><b>${esc(company.email || 'Sin completar')}</b></div></section><section class="dossier-section"><div class="section-heading"><h2>Personal del evento</h2><span>${staff.rowCount} personas informadas</span></div>${staffTable}</section>`;
  } else if (['seguros','habilitaciones','servicios','prensa','tecnica','sponsors'].includes(key)) {
    const action = `/events/${req.event.id}/modules/${key}/items?_csrf=${req.csrfToken}`;
    const categories = {
      seguros: ['Responsabilidad Civil','Accidentes Personales','ART','Otros'],
      habilitaciones: ['Permisos','Habilitación municipal','Expediente/Trámite municipal','AGC','TAD','Bomberos','Plan de Evacuación','Otros'],
      servicios: ['Servicio Médico / Ambulancia','Policía / Seguridad Privada','SADAIC','AADI-CAPIF','Otros'],
      prensa: ['Instagram Post','Instagram Story','Pantallas LED','Marquesina exterior','Logos PNG','Fotos del artista','Material de prensa','Otros'],
      tecnica: ['Rider Técnico','Audio','Iluminación','Pantallas / Video','Backline','Stage Plot','Hospitality','Catering','Otros'],
      sponsors: ['Sponsor','Acuerdo preexistente del Club'],
    }[key];
    content = canEdit ? `<form method="post" enctype="multipart/form-data" action="${action}" class="panel form-grid upload-form">
      <label>Categoria<select name="category">${optionList(categories)}</select></label><label>Tipo / Marca / Prestador<input name="title"></label><label>Numero / Vigencia<input name="reference"></label><label class="span">Observacion<textarea name="observation"></textarea></label><label class="span">Archivo<input type="file" name="file" required></label><progress hidden max="100"></progress><button class="primary span">Guardar</button></form>` : '<section class="readonly-notice"><b>Vista de solo lectura</b><span>Documentacion cargada por el productor.</span></section>';
  } else if (key === 'comercial') {
    const ticketing = (await db.query('select * from ticketing where event_id=$1', [req.event.id])).rows[0] || {};
    const sectors = await db.query('select * from ticket_sectors where event_id=$1', [req.event.id]);
    const phases = await db.query('select * from sales_phases where event_id=$1', [req.event.id]);
    content = `<form method="post" action="/events/${req.event.id}/modules/comercial/ticketing" class="panel form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}"><label>Nombre de Ticketera<input name="ticketing_name" value="${esc(ticketing.ticketing_name)}"></label><label>Contacto<input name="contact" value="${esc(ticketing.contact)}"></label><label class="span">Observaciones<textarea name="observations">${esc(ticketing.observations)}</textarea></label><button class="primary span">Guardar Ticketera</button></form>
    <section class="panel"><h2>Sectores</h2><form method="post" action="/events/${req.event.id}/modules/comercial/sectors" class="inline-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}"><input name="name" placeholder="Nombre" required><input name="capacity" type="number" placeholder="Capacidad"><input name="price" type="number" step="0.01" placeholder="Precio"><input name="observation" placeholder="Observación"><button>+ Agregar Sector</button></form>${table(['Nombre','Capacidad','Precio','Obs'], sectors.rows.map((s)=>`<tr><td>${esc(s.name)}</td><td>${esc(s.capacity)}</td><td>${esc(s.price)}</td><td>${esc(s.observation)}</td></tr>`))}</section>
    <section class="panel"><h2>Fases de Venta</h2><form method="post" action="/events/${req.event.id}/modules/comercial/phases" class="inline-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}"><input name="name" placeholder="Nombre" required><input name="date_from" type="date"><input name="date_to" type="date"><button>+ Agregar Fase</button></form>${table(['Nombre','Desde','Hasta'], phases.rows.map((p)=>`<tr><td>${esc(p.name)}</td><td>${esc(p.date_from)}</td><td>${esc(p.date_to)}</td></tr>`))}</section>
    <section class="panel"><h2>Cortesías, promociones, imágenes y legales</h2><form method="post" enctype="multipart/form-data" action="/events/${req.event.id}/modules/comercial/items?_csrf=${req.csrfToken}" class="upload-form inline-grid"><input name="category" value="Imagen/Legal Ticketera"><input name="observation" placeholder="Observación"><input type="file" name="file" required><button>Adjuntar</button><progress hidden max="100"></progress></form></section>`;
    if (!canEdit) content = `<section class="readonly-details"><div><small>Ticketera</small><b>${esc(ticketing.ticketing_name || 'Sin completar')}</b></div><div><small>Contacto</small><b>${esc(ticketing.contact || 'Sin completar')}</b></div><div><small>Observaciones</small><b>${esc(ticketing.observations || 'Sin observaciones')}</b></div></section><section class="dossier-section"><h2>Sectores</h2>${table(['Nombre','Capacidad','Precio','Observación'], sectors.rows.map((s)=>`<tr><td>${esc(s.name)}</td><td>${esc(s.capacity)}</td><td>${esc(s.price)}</td><td>${esc(s.observation)}</td></tr>`))}</section><section class="dossier-section"><h2>Fases de venta</h2>${table(['Nombre','Desde','Hasta'], phases.rows.map((p)=>`<tr><td>${esc(p.name)}</td><td>${esc(p.date_from)}</td><td>${esc(p.date_to)}</td></tr>`))}</section>`;
  } else if (key === 'aceptacion') {
    const statusRows = MODULES.filter((m) => m.key !== 'aceptacion').map((m) => `<tr><td>${esc(m.name)}</td><td><span class="badge">${esc(req.event.module_statuses[m.key] || 'PENDIENTE')}</span></td><td><a href="/events/${req.event.id}/modules/${m.key}">Ver módulo</a></td></tr>`);
    content = `<section><div class="section-heading"><h2>Resumen de revisiones</h2><span>Las decisiones se registran dentro de cada módulo</span></div>${table(['Módulo','Estado','Detalle'], statusRows)}</section>`;
  } else if (key === 'ticketera') {
    const ticketing = (await db.query('select * from ticketing where event_id=$1', [req.event.id])).rows[0] || {};
    const approvals = await db.query('select a.*, u.first_name, u.last_name from ticketing_approvals a left join users u on u.id=a.created_by where event_id=$1 order by created_at desc', [req.event.id]);
    content = `<form method="post" action="/events/${req.event.id}/modules/ticketera/link" class="panel form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}"><label>Nombre de Ticketera<input name="ticketing_name" value="${esc(ticketing.ticketing_name)}"></label><label>URL/link de venta<input name="sales_url" value="${esc(ticketing.sales_url)}"></label><label>Fecha<input type="date" name="sales_date" value="${esc(ticketing.sales_date)}"></label><label class="span">Observaciones<textarea name="sales_observations">${esc(ticketing.sales_observations)}</textarea></label><button class="primary span">Guardar link</button></form>
    ${ticketing.sales_url ? `<a class="primary" target="_blank" href="${esc(ticketing.sales_url)}">Abrir evento en Ticketera</a>` : ''}
    ${table(['Decisión','Comentario','Usuario','Fecha'], approvals.rows.map((a)=>`<tr><td>${esc(a.decision)}</td><td>${esc(a.comment)}</td><td>${esc(a.first_name)} ${esc(a.last_name)}</td><td>${esc(a.created_at)}</td></tr>`))}`;
    if (!isManager(req.user)) content = `<section class="readonly-details"><div><small>Ticketera</small><b>${esc(ticketing.ticketing_name || 'Sin completar')}</b></div><div><small>Link de venta</small><b>${ticketing.sales_url ? `<a target="_blank" href="${esc(ticketing.sales_url)}">Abrir enlace</a>` : 'Sin completar'}</b></div><div><small>Fecha</small><b>${esc(ticketing.sales_date || 'Sin completar')}</b></div><div><small>Observaciones</small><b>${esc(ticketing.sales_observations || 'Sin observaciones')}</b></div></section>${table(['Decisión','Comentario','Usuario','Fecha'], approvals.rows.map((a)=>`<tr><td>${esc(a.decision)}</td><td>${esc(a.comment)}</td><td>${esc(a.first_name)} ${esc(a.last_name)}</td><td>${esc(a.created_at)}</td></tr>`))}`;
  }
  const attachmentCards = files.rows.map((f) => {
    const actions = [];
    if (canViewEventFile(req.user)) actions.push(`<a href="/files/${f.id}/view" target="_blank">Ver</a>`);
    if (canDownloadEventFile(req.user)) actions.push(`<a href="/files/${f.id}/download">Descargar</a>`);
    const deleteForm = canDeleteEventFile(req.user, req.event)
      ? `<form method="post" action="/files/${f.id}/delete"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button>Eliminar</button></form>`
      : '';
    return `<article class="file-card"><b>${esc(f.original_name)}</b><small>${Math.round(f.size_bytes/1024)} KB · ${esc(f.mime_type)}</small>${actions.length ? `<div>${actions.join('')}</div>` : '<small>Archivo cargado</small>'}${deleteForm}</article>`;
  }).join('');
  const history = statusHistory.rows.map((h)=>`<li><b>${esc(h.new_status)}</b> ${esc(h.observation)} <small>${esc(h.created_at)}</small></li>`).join('');
  const downloads = isAdmin(req.user)
    ? `<div class="module-actions"><a href="/events/${req.event.id}/modules/${key}/pdf">Descargar PDF</a><a href="/events/${req.event.id}/zip">Descargar Todo</a></div>`
    : '';
  const currentStatus = req.event.module_statuses[key] || 'PENDIENTE';
  const latestReview = statusHistory.rows.find((entry) => entry.new_status !== 'CARGADO');
  const producerStatusLabels = {
    APROBADO: 'Aprobado por administración',
    OBSERVADO: 'Observado por administración',
    CARGADO: 'Enviado para revisión',
    PENDIENTE: 'Pendiente',
  };
  const reviewPanel = canReviewEventContent(req.user) && key !== 'aceptacion'
    ? `<section class="panel review-panel"><div><small>Control administrativo</small><h2>Revisión del módulo</h2><p>Estado actual: <span class="badge">${esc(currentStatus)}</span></p></div><form method="post" action="/events/${req.event.id}/review/${key}" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}"><label>Decisión<select name="status"><option>APROBADO</option><option>OBSERVADO</option><option>PENDIENTE</option></select></label><label class="span">Comentario<textarea name="observation" placeholder="Detalle de la aprobación u observación"></textarea></label><button class="primary span">Guardar revisión</button></form></section>`
    : '';
  const producerReviewStatus = canEdit && key !== 'aceptacion'
    ? `<section class="producer-review-status ${currentStatus.toLowerCase()}"><div><small>Estado de revisión</small><h2>${esc(producerStatusLabels[currentStatus] || currentStatus)}</h2><p>${latestReview?.new_status === currentStatus && latestReview.observation ? esc(latestReview.observation) : currentStatus === 'CARGADO' ? 'La documentación está disponible para control administrativo.' : 'Todavía no hay comentarios del administrador.'}</p></div><span class="badge">${esc(currentStatus)}</span></section>`
    : '';
  const historySection = canEdit ? '' : `<section class="panel"><h2>Historial</h2><ul class="history">${history || '<li>Sin movimientos.</li>'}</ul></section>`;
  res.send(layout(req, req.event.name, `${eventHeader(req.event, key)}${downloads}${content}<section class="files">${attachmentCards}</section>${historySection}${reviewPanel}${producerReviewStatus}`));
});

app.post('/events/:eventId/modules/identificacion/company', requireLogin, loadAuthorizedEvent, requireRole(ROLES.PRODUCER), async (req, res) => {
  await db.query(`insert into event_companies (event_id,legal_name,cuit,responsible,phone,email) values ($1,$2,$3,$4,$5,$6)
    on conflict (event_id) do update set legal_name=$2,cuit=$3,responsible=$4,phone=$5,email=$6,updated_at=now()`,
    [req.event.id, req.body.legal_name, req.body.cuit, req.body.responsible, req.body.phone, req.body.email]);
  await markLoaded(req.event.id, 'identificacion', req.user.id);
  await audit(req.user.id, 'guardar_identificacion', 'events', req.event.id);
  flash(req, 'ok', 'Guardado correctamente.');
  res.redirect(`/events/${req.event.id}/modules/identificacion`);
});

app.get('/events/:eventId/staff/template', requireLogin, loadAuthorizedEvent, async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla-personal.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await workbookTemplateBuffer());
});

app.post('/events/:eventId/staff/import', requireLogin, loadAuthorizedEvent, requireRole(ROLES.PRODUCER), upload.single('file'), async (req, res) => {
  const attachment = await saveAttachment({ file: req.file, eventId: req.event.id, moduleKey: 'identificacion', userId: req.user.id });
  const parsed = await parseStaff(req.file.path);
  const importRow = await db.query('insert into staff_imports (event_id,attachment_id,total_rows,valid_rows,error_rows,errors,imported_by,confirmed_at) values ($1,$2,$3,$4,$5,$6,$7,case when $5=0 then now() else null end) returning id', [req.event.id, attachment.id, parsed.total, parsed.valid, parsed.invalid, JSON.stringify(parsed.errors), req.user.id]);
  if (parsed.invalid === 0) {
    await db.tx(async (client) => {
      for (const p of parsed.people) await client.query('insert into event_staff (event_id,first_name,last_name,cuit,role_title,company,phone,email,import_batch_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [req.event.id, p.first_name, p.last_name, p.cuit, p.role_title, p.company, p.phone, p.email, importRow.rows[0].id]);
    });
    await markLoaded(req.event.id, 'identificacion', req.user.id);
    flash(req, 'ok', `${parsed.total} personas detectadas, ${parsed.valid} correctas, importadas correctamente.`);
  } else {
    flash(req, 'error', `${parsed.total} personas detectadas. ${parsed.valid} correctas y ${parsed.invalid} con errores: ${parsed.errors.slice(0,3).map((e)=>`Fila ${e.row} - ${e.problem}`).join('; ')}`);
  }
  await audit(req.user.id, 'importar_personal_excel', 'events', req.event.id, parsed);
  res.redirect(`/events/${req.event.id}/modules/identificacion`);
});

app.post('/events/:eventId/staff', requireLogin, loadAuthorizedEvent, requireRole(ROLES.PRODUCER), async (req, res) => {
  await db.query('insert into event_staff (event_id,first_name,last_name,cuit,role_title,company,phone,email) values ($1,$2,$3,$4,$5,$6,$7,$8)', [req.event.id, req.body.first_name, req.body.last_name, req.body.cuit, req.body.role_title, req.body.company, req.body.phone, req.body.email]);
  await markLoaded(req.event.id, 'identificacion', req.user.id);
  await audit(req.user.id, 'agregar_personal', 'events', req.event.id);
  res.redirect(`/events/${req.event.id}/modules/identificacion`);
});

app.post('/events/:eventId/modules/:moduleKey/items', requireLogin, loadAuthorizedEvent, requireRole(ROLES.PRODUCER), upload.single('file'), async (req, res) => {
  const key = req.params.moduleKey;
  const attachment = await saveAttachment({ file: req.file, eventId: req.event.id, moduleKey: key, userId: req.user.id });
  const title = req.body.title || req.body.category;
  const tableMap = {
    seguros: ['insurances', ['type','valid_until','observation','attachment_id'], [title, req.body.reference || null, req.body.observation, attachment.id]],
    habilitaciones: ['permits', ['type','reference_number','observation','attachment_id'], [req.body.category, req.body.reference || null, req.body.observation, attachment.id]],
    servicios: ['mandatory_services', ['category','provider','observation','attachment_id'], [req.body.category, title, req.body.observation, attachment.id]],
    prensa: ['assets', ['category','observation','attachment_id'], [req.body.category, req.body.observation, attachment.id]],
    tecnica: ['technical_documents', ['category','observation','attachment_id'], [req.body.category, req.body.observation, attachment.id]],
    comercial: ['assets', ['category','observation','attachment_id'], [req.body.category, req.body.observation, attachment.id]],
    sponsors: ['sponsors', ['brand','agreement_type','description','observation','attachment_id'], [title, req.body.category, req.body.observation, req.body.reference, attachment.id]],
  };
  const [tableName, cols, values] = tableMap[key];
  await db.query(`insert into ${tableName} (event_id,${cols.join(',')}) values ($1,${cols.map((_, i)=>`$${i+2}`).join(',')})`, [req.event.id, ...values]);
  await markLoaded(req.event.id, key, req.user.id);
  await audit(req.user.id, 'cargar_archivo_modulo', tableName, req.event.id, { module: key });
  res.redirect(`/events/${req.event.id}/modules/${key}`);
});

app.post('/events/:eventId/modules/comercial/ticketing', requireLogin, loadAuthorizedEvent, requireRole(ROLES.PRODUCER), async (req, res) => {
  await db.query(`insert into ticketing (event_id,ticketing_name,contact,observations) values ($1,$2,$3,$4)
    on conflict (event_id) do update set ticketing_name=$2,contact=$3,observations=$4,updated_at=now()`, [req.event.id, req.body.ticketing_name, req.body.contact, req.body.observations]);
  await markLoaded(req.event.id, 'comercial', req.user.id);
  res.redirect(`/events/${req.event.id}/modules/comercial`);
});

app.post('/events/:eventId/modules/comercial/sectors', requireLogin, loadAuthorizedEvent, requireRole(ROLES.PRODUCER), async (req, res) => {
  await db.query('insert into ticket_sectors (event_id,name,capacity,price,observation) values ($1,$2,$3,$4,$5)', [req.event.id, req.body.name, req.body.capacity || null, req.body.price || null, req.body.observation]);
  await markLoaded(req.event.id, 'comercial', req.user.id);
  res.redirect(`/events/${req.event.id}/modules/comercial`);
});

app.post('/events/:eventId/modules/comercial/phases', requireLogin, loadAuthorizedEvent, requireRole(ROLES.PRODUCER), async (req, res) => {
  await db.query('insert into sales_phases (event_id,name,date_from,date_to) values ($1,$2,$3,$4)', [req.event.id, req.body.name, req.body.date_from || null, req.body.date_to || null]);
  await markLoaded(req.event.id, 'comercial', req.user.id);
  res.redirect(`/events/${req.event.id}/modules/comercial`);
});

app.post('/events/:eventId/modules/ticketera/link', requireLogin, loadAuthorizedEvent, requireRole(ROLES.MANAGER), async (req, res) => {
  await db.query(`insert into ticketing (event_id,ticketing_name,sales_url,sales_date,sales_observations) values ($1,$2,$3,$4,$5)
    on conflict (event_id) do update set ticketing_name=$2,sales_url=$3,sales_date=$4,sales_observations=$5,updated_at=now()`, [req.event.id, req.body.ticketing_name, req.body.sales_url, req.body.sales_date || null, req.body.sales_observations]);
  const owner = (await db.query('select email from users where id=$1', [req.event.owner_user_id])).rows[0];
  if (owner) await sendMail(owner.email, 'Ticketera lista', 'La ticketera esta lista para revision.');
  await markLoaded(req.event.id, 'ticketera', req.user.id);
  res.redirect(`/events/${req.event.id}/modules/ticketera`);
});

app.post('/events/:eventId/ticketera/decision', requireLogin, loadAuthorizedEvent, requireRole(ROLES.ADMIN, ROLES.MANAGER), async (req, res) => {
  if (req.body.decision === 'OBSERVADO' && !req.body.comment) { flash(req, 'error', 'El comentario es obligatorio al observar.'); return res.redirect(`/events/${req.event.id}/modules/ticketera`); }
  await db.query('insert into ticketing_approvals (event_id,decision,comment,created_by) values ($1,$2,$3,$4)', [req.event.id, req.body.decision, req.body.comment, req.user.id]);
  await audit(req.user.id, 'decision_ticketera', 'events', req.event.id, { decision: req.body.decision });
  await notifyEventOwner(req.event.id, 'REVISION_TICKETERA', `Revision de ticketera: ${req.event.name}`, reviewNotificationMessage('ticketera', req.body.decision, req.body.comment), `/events/${req.event.id}/modules/ticketera`);
  res.redirect(`/events/${req.event.id}/modules/ticketera`);
});

app.post('/events/:eventId/review/:moduleKey', requireLogin, loadAuthorizedEvent, requireRole(ROLES.ADMIN, ROLES.MANAGER), async (req, res) => {
  if (!['APROBADO','OBSERVADO','PENDIENTE'].includes(req.body.status)) return res.status(400).send('Estado invalido');
  if (req.body.status === 'OBSERVADO' && !req.body.observation) { flash(req, 'error', 'La observación es obligatoria.'); return res.redirect(`/events/${req.event.id}/modules/${req.params.moduleKey}`); }
  const previous = (await db.query('select status from event_modules where event_id=$1 and module_key=$2', [req.event.id, req.params.moduleKey])).rows[0]?.status;
  await db.tx(async (client) => {
    await client.query('update event_modules set status=$3, updated_at=now() where event_id=$1 and module_key=$2', [req.event.id, req.params.moduleKey, req.body.status]);
    await client.query('insert into module_status_history (event_id,module_key,previous_status,new_status,observation,created_by) values ($1,$2,$3,$4,$5,$6)', [req.event.id, req.params.moduleKey, previous, req.body.status, req.body.observation, req.user.id]);
  });
  await audit(req.user.id, 'revision_modulo', 'events', req.event.id, { module: req.params.moduleKey, status: req.body.status });
  await notifyEventOwner(req.event.id, 'REVISION_MODULO', `Revision de ${req.event.name}`, reviewNotificationMessage(req.params.moduleKey, req.body.status, req.body.observation), `/events/${req.event.id}/modules/${req.params.moduleKey}`);
  flash(req, 'ok', 'Revision guardada y productor notificado.');
  res.redirect(`/events/${req.event.id}/modules/${req.params.moduleKey}`);
});

app.get('/events/:eventId/modules/:moduleKey/pdf', requireLogin, loadAuthorizedEvent, requireRole(ROLES.ADMIN), async (req, res) => {
  const buffer = await modulePdf(req.event, req.params.moduleKey, app.locals.portalSettings);
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.moduleKey}.pdf"`);
  res.type('application/pdf').send(buffer);
});

app.get('/events/:eventId/zip', requireLogin, loadAuthorizedEvent, requireRole(ROLES.ADMIN), async (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="${req.event.name}.zip"`);
  res.type('application/zip');
  await streamEventZip(res, req.event, app.locals.portalSettings);
});

app.get('/files/:id/:mode(view|download)', requireLogin, async (req, res) => {
  const file = (await db.query('select * from attachments where id=$1 and deleted_at is null', [req.params.id])).rows[0];
  if (!file) return res.status(404).send('Archivo no encontrado');
  if (file.event_id) {
    req.params.eventId = file.event_id;
    await new Promise((resolve) => loadAuthorizedEvent(req, res, resolve));
    if (!req.event) return;
    if (req.params.mode === 'download' && !canDownloadEventFile(req.user)) return res.status(403).send('Acceso denegado');
    if (req.params.mode === 'view' && !canViewEventFile(req.user)) return res.status(403).send('Acceso denegado');
  } else if (!isAdmin(req.user)) return res.status(403).send('Acceso denegado');
  const target = resolveAttachment(file);
  res.setHeader('Content-Disposition', `${req.params.mode === 'download' ? 'attachment' : 'inline'}; filename="${file.original_name}"`);
  res.type(file.mime_type);
  fs.createReadStream(target).pipe(res);
});

app.post('/files/:id/delete', requireLogin, async (req, res) => {
  const file = (await db.query('select * from attachments where id=$1 and deleted_at is null', [req.params.id])).rows[0];
  if (!file) return res.status(404).send('Archivo no encontrado');
  if (file.event_id) {
    req.params.eventId = file.event_id;
    await new Promise((resolve) => loadAuthorizedEvent(req, res, resolve));
    if (!req.event) return;
    if (!canDeleteEventFile(req.user, req.event)) return res.status(403).send('Acceso denegado');
  } else if (!isAdmin(req.user)) return res.status(403).send('Acceso denegado');
  await db.query('update attachments set deleted_at=now() where id=$1', [file.id]);
  await audit(req.user.id, 'eliminar_archivo', 'attachments', file.id, { event_id: file.event_id, module: file.module_key });
  flash(req, 'ok', 'Archivo eliminado.');
  res.redirect(file.event_id ? `/events/${file.event_id}/modules/${file.module_key}` : '/admin/settings');
});

app.get('/notifications', requireLogin, async (req, res) => {
  const notifications = await db.query('select * from notifications where user_id=$1 order by created_at desc limit 100', [req.user.id]);
  const items = notifications.rows.map((notification) => `<article class="notification-item ${notification.read_at ? '' : 'unread'}"><div><span class="badge">${esc(notification.type.replaceAll('_', ' '))}</span><h2>${esc(notification.title)}</h2><p>${esc(notification.message)}</p><small>${esc(new Date(notification.created_at).toLocaleString('es-AR'))}</small></div><form method="post" action="/notifications/${notification.id}/read"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button>${notification.read_at ? 'Abrir' : 'Ver y marcar leida'}</button></form></article>`).join('');
  res.send(layout(req, 'Notificaciones', `<section class="toolbar"><div><h1>Notificaciones</h1><p>${req.user.unread_notifications} pendientes.</p></div>${req.user.unread_notifications ? `<form method="post" action="/notifications/read-all"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button>Marcar todas como leidas</button></form>` : ''}</section><section class="notification-list">${items || '<p class="empty">No hay notificaciones.</p>'}</section>`));
});

app.post('/notifications/read-all', requireLogin, async (req, res) => {
  await db.query('update notifications set read_at=now() where user_id=$1 and read_at is null', [req.user.id]);
  res.redirect('/notifications');
});

app.post('/notifications/:id/read', requireLogin, async (req, res) => {
  const notification = (await db.query('update notifications set read_at=coalesce(read_at,now()) where id=$1 and user_id=$2 returning link', [req.params.id, req.user.id])).rows[0];
  if (!notification) return res.status(404).send('Notificacion no encontrada');
  res.redirect(notification.link || '/notifications');
});

app.get('/profile', requireLogin, (req, res) => res.send(layout(req, 'Perfil', `<form method="post" action="/profile" class="panel form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">${['first_name:Nombre','last_name:Apellido','phone:Teléfono','email:Email'].map((x)=>{const[n,l]=x.split(':'); return `<label>${l}<input name="${n}" value="${esc(req.user[n])}" required></label>`}).join('')}<label>Nueva contraseña<input name="password" type="password" minlength="8"></label><button class="primary span">Guardar perfil</button></form>`)));

app.post('/profile', requireLogin, async (req, res) => {
  if (req.body.password) await db.query('update users set first_name=$1,last_name=$2,phone=$3,email=$4,password_hash=$5,updated_at=now() where id=$6', [req.body.first_name, req.body.last_name, req.body.phone, req.body.email, await hashPassword(req.body.password), req.user.id]);
  else await db.query('update users set first_name=$1,last_name=$2,phone=$3,email=$4,updated_at=now() where id=$5', [req.body.first_name, req.body.last_name, req.body.phone, req.body.email, req.user.id]);
  flash(req, 'ok', 'Guardado correctamente.');
  res.redirect('/profile');
});

app.get('/admin', requireLogin, requireRole(ROLES.ADMIN), async (req, res) => {
  const counts = await db.query(`select (select count(*) from users) users, (select count(*) from events) events`);
  res.send(layout(req, 'Administracion', `<section class="admin-grid">${['Productores:/admin/users','Eventos:/admin/events','Revisiones:/admin/reviews','Configuración:/admin/settings'].map((x)=>{const[l,h]=x.split(':'); return `<a class="panel admin-tile" href="${h}"><b>${l}</b></a>`}).join('')}</section><p class="panel">Usuarios: ${counts.rows[0].users} · Eventos: ${counts.rows[0].events}</p>`));
});

app.get('/admin/users', requireLogin, requireRole(ROLES.ADMIN), async (req, res) => {
  const users = await db.query(`select u.*, count(e.id) event_count, array_remove(array_agg(r.name), null) roles from users u left join events e on e.owner_user_id=u.id left join user_roles ur on ur.user_id=u.id left join roles r on r.id=ur.role_id group by u.id order by u.created_at desc`);
  const rows = users.rows.map((u)=>`<tr><td>${esc(u.first_name)} ${esc(u.last_name)}</td><td>${esc(u.email)}</td><td>${esc(u.phone)}</td><td>${esc(u.status)}</td><td>${esc((u.roles || []).join(', '))}</td><td>${u.event_count}</td><td><form method="post" action="/admin/users/${u.id}/status"><input type="hidden" name="_csrf" value="${req.csrfToken}"><select name="status">${optionList(['PENDIENTE','ACTIVO','BLOQUEADO','DESHABILITADO'], u.status)}</select><button>Estado</button></form><form method="post" action="/admin/users/${u.id}/role"><input type="hidden" name="_csrf" value="${req.csrfToken}"><select name="role">${optionList(['PRODUCTOR','GERENCIADORA','ADMINISTRADOR'], (u.roles || [])[0])}</select><button>Rol</button></form></td></tr>`);
  res.send(layout(req, 'Productores', `<h1>Productores y usuarios</h1>${table(['Nombre','Email','Teléfono','Estado','Roles','Eventos','Acciones'], rows)}`));
});

app.post('/admin/users/:id/status', requireLogin, requireRole(ROLES.ADMIN), async (req, res) => {
  await db.query('update users set status=$1, updated_at=now() where id=$2', [req.body.status, req.params.id]);
  await audit(req.user.id, 'cambiar_estado_usuario', 'users', req.params.id, { status: req.body.status });
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/role', requireLogin, requireRole(ROLES.ADMIN), async (req, res) => {
  await db.tx(async (client) => {
    await client.query('delete from user_roles where user_id=$1', [req.params.id]);
    await client.query('insert into user_roles (user_id, role_id) select $1, id from roles where name=$2', [req.params.id, req.body.role]);
  });
  await audit(req.user.id, 'cambiar_rol_usuario', 'users', req.params.id, { role: req.body.role });
  res.redirect('/admin/users');
});

app.get('/admin/events', requireLogin, requireRole(ROLES.ADMIN), async (req, res) => {
  const events = await db.query(`
    select e.*, u.first_name || ' ' || u.last_name producer,
      count(distinct a.id) filter (where a.deleted_at is null) file_count,
      count(distinct m.module_key) filter (where m.status <> 'PENDIENTE') active_modules,
      max(a.created_at) filter (where a.deleted_at is null) last_upload
    from events e
    join users u on u.id=e.owner_user_id
    left join event_modules m on m.event_id=e.id
    left join attachments a on a.event_id=e.id
    group by e.id,u.id
    order by coalesce(max(a.created_at),e.created_at) desc`);
  const managers = await db.query(`select u.id, u.first_name || ' ' || u.last_name name from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id where r.name='GERENCIADORA' and u.status='ACTIVO' order by name`);
  const managerOptions = managers.rows.map((m)=>`<option value="${m.id}">${esc(m.name)}</option>`).join('');
  const rows = events.rows.map((event) => {
    const completion = moduleCompletion(event.active_modules);
    return `<tr>
    <td><b>${esc(event.name)}</b><br><small>${esc(event.artist)} · ${esc(event.venue)}</small></td>
    <td>${esc(event.producer)}</td>
    <td><div class="table-progress"><div><b>${completion.completed}% completado</b><small>${completion.missing}% faltante</small></div><progress max="100" value="${completion.completed}">${completion.completed}%</progress><small>${event.active_modules}/10 módulos · ${event.file_count} archivos</small></div></td>
    <td>${event.last_upload ? esc(new Date(event.last_upload).toLocaleString('es-AR')) : 'Sin cargas'}</td>
    <td><a class="button" href="/admin/events/${event.id}">Ver expediente</a></td>
    <td>${managerOptions ? `<form method="post" action="/admin/events/${event.id}/manager"><input type="hidden" name="_csrf" value="${req.csrfToken}"><select name="manager_id">${managerOptions}</select><button>Asignar</button></form>` : '<small>Sin gerenciadoras activas</small>'}</td>
  </tr>`;
  });
  res.send(layout(req, 'Eventos', `<section class="toolbar"><div><h1>Eventos</h1><p>Seguimiento de documentación y avance por productor.</p></div></section>${table(['Evento','Productor','Avance','Última carga','Expediente','Gerenciadora'], rows)}`));
});

app.get('/admin/events/:id', requireLogin, requireRole(ROLES.ADMIN), async (req, res) => {
  const event = (await db.query(`
    select e.*, u.first_name || ' ' || u.last_name producer,
      u.email producer_email,u.phone producer_phone
    from events e join users u on u.id=e.owner_user_id where e.id=$1`, [req.params.id])).rows[0];
  if (!event) return res.status(404).send('Evento no encontrado');

  const [dates, company, moduleRows, fileRows, staff, ticketing] = await Promise.all([
    db.query('select show_date from event_dates where event_id=$1 order by show_date', [event.id]),
    db.query('select * from event_companies where event_id=$1', [event.id]),
    db.query(`select m.*,count(a.id) filter (where a.deleted_at is null) file_count,
      max(a.created_at) filter (where a.deleted_at is null) last_upload
      from event_modules m left join attachments a on a.event_id=m.event_id and a.module_key=m.module_key
      where m.event_id=$1 group by m.event_id,m.module_key order by m.module_name`, [event.id]),
    db.query(`select a.*,u.username,
      coalesce(i.type,p.type,svc.category,asset.category,tech.category,sp.brand,ca.title) entry_title,
      coalesce(i.valid_until::text,p.reference_number,svc.provider,sp.agreement_type) reference_detail,
      coalesce(i.observation,p.observation,svc.observation,asset.observation,tech.observation,sp.observation) entry_observation
      from attachments a
      left join users u on u.id=a.uploaded_by
      left join insurances i on i.attachment_id=a.id
      left join permits p on p.attachment_id=a.id
      left join mandatory_services svc on svc.attachment_id=a.id
      left join assets asset on asset.attachment_id=a.id
      left join technical_documents tech on tech.attachment_id=a.id
      left join sponsors sp on sp.attachment_id=a.id
      left join club_agreements ca on ca.attachment_id=a.id
      where a.event_id=$1 and a.deleted_at is null order by a.created_at desc`, [event.id]),
    db.query('select count(*) count from event_staff where event_id=$1', [event.id]),
    db.query('select * from ticketing where event_id=$1', [event.id]),
  ]);

  const companyData = company.rows[0] || {};
  const ticketingData = ticketing.rows[0] || {};
  const moduleOrder = new Map(MODULES.map((module) => [module.key, module.order]));
  const modules = moduleRows.rows.sort((a, b) => moduleOrder.get(a.module_key) - moduleOrder.get(b.module_key));
  const activeModules = modules.filter((module) => module.status !== 'PENDIENTE').length;
  const completion = moduleCompletion(activeModules);
  const approvedModules = modules.filter((module) => module.status === 'APROBADO').length;
  const observedModules = modules.filter((module) => module.status === 'OBSERVADO').length;
  const dateList = dates.rows.map((row) => new Date(row.show_date).toLocaleDateString('es-AR', { timeZone: 'UTC' })).join(', ') || 'Sin fecha';

  const moduleTable = table(
    ['Módulo','Estado','Archivos','Última carga','Acción'],
    modules.map((module) => `<tr><td><b>${esc(module.module_name)}</b></td><td><span class="badge">${esc(module.status)}</span></td><td>${module.file_count}</td><td>${module.last_upload ? esc(new Date(module.last_upload).toLocaleString('es-AR')) : 'Sin cargas'}</td><td><a href="/events/${event.id}/modules/${module.module_key}">Ver detalle</a></td></tr>`),
  );

  const fileTable = table(
    ['Módulo','Información','Archivo','Cargado por','Fecha','Acciones'],
    fileRows.rows.map((file) => {
      const moduleName = MODULES.find((module) => module.key === file.module_key)?.name || file.module_key;
      const details = [file.entry_title, file.reference_detail, file.entry_observation].filter(Boolean).join(' · ');
      return `<tr><td>${esc(moduleName)}</td><td>${esc(details || 'Documento adjunto')}</td><td><b>${esc(file.original_name)}</b><br><small>${Math.round(file.size_bytes / 1024)} KB · ${esc(file.mime_type)}</small></td><td>${esc(file.username)}</td><td>${esc(new Date(file.created_at).toLocaleString('es-AR'))}</td><td><div class="row-actions"><a href="/files/${file.id}/view" target="_blank">Ver</a><a href="/files/${file.id}/download">Descargar</a></div></td></tr>`;
    }),
  );

  const identity = `<section class="detail-band"><div><small>Productor</small><b>${esc(event.producer)}</b><span>${esc(event.producer_email)}${event.producer_phone ? ` · ${esc(event.producer_phone)}` : ''}</span></div><div><small>Empresa</small><b>${esc(companyData.legal_name || 'Sin completar')}</b><span>${esc(companyData.cuit || '')}</span></div><div><small>Responsable</small><b>${esc(companyData.responsible || 'Sin completar')}</b><span>${esc(companyData.email || '')}</span></div><div><small>Ticketera</small><b>${esc(ticketingData.ticketing_name || 'Sin completar')}</b><span>${esc(ticketingData.contact || '')}</span></div></section>`;

  res.send(layout(req, `Expediente ${event.name}`, `
    <section class="dossier-head"><a href="/admin/events">← Eventos</a><div class="toolbar"><div><h1>${esc(event.name)}</h1><p>${esc(event.artist)} · ${esc(event.venue)}, ${esc(event.city)} · ${esc(dateList)}</p></div><a class="primary" href="/events/${event.id}/zip">Descargar ZIP</a></div></section>
    <section class="completion-overview"><div><small>Estado de carga</small><strong>${completion.completed}% completado</strong><span>${completion.missing}% de datos faltantes · ${activeModules} de 10 módulos con información</span></div><progress max="100" value="${completion.completed}">${completion.completed}%</progress></section>
    <section class="summary-strip"><div><strong>${activeModules}/10</strong><span>Módulos con actividad</span></div><div><strong>${approvedModules}</strong><span>Aprobados</span></div><div><strong>${observedModules}</strong><span>Observados</span></div><div><strong>${fileRows.rowCount}</strong><span>Archivos</span></div><div><strong>${staff.rows[0].count}</strong><span>Personas</span></div></section>
    ${identity}
    <section class="dossier-section"><div class="section-heading"><h2>Avance por módulo</h2><span>${activeModules} de 10 con información</span></div>${moduleTable}</section>
    <section class="dossier-section"><div class="section-heading"><h2>Archivos cargados</h2><span>${fileRows.rowCount} documentos</span></div>${fileTable}</section>
  `));
});

app.post('/admin/events/:id/manager', requireLogin, requireRole(ROLES.ADMIN), async (req, res) => {
  if (!req.body.manager_id) {
    flash(req, 'error', 'Seleccione una gerenciadora activa.');
    return res.redirect('/admin/events');
  }
  await db.query('insert into event_manager_access (event_id,user_id) values ($1,$2) on conflict do nothing', [req.params.id, req.body.manager_id]);
  await audit(req.user.id, 'asignar_gerenciadora', 'events', req.params.id, { manager_id: req.body.manager_id });
  res.redirect('/admin/events');
});

app.get('/admin/reviews', requireLogin, requireRole(ROLES.ADMIN), async (req, res) => {
  const mods = await db.query(`select m.*, e.name event_name from event_modules m join events e on e.id=m.event_id where m.status in ('CARGADO','OBSERVADO') order by m.updated_at desc`);
  res.send(layout(req, 'Revisiones', `<h1>Revisiones</h1>${table(['Evento','Módulo','Estado','Acción'], mods.rows.map((m)=>`<tr><td>${esc(m.event_name)}</td><td>${esc(m.module_name)}</td><td>${esc(m.status)}</td><td><a href="/events/${m.event_id}/modules/${m.module_key}">Revisar módulo</a></td></tr>`))}`));
});

app.get('/admin/settings', requireLogin, requireRole(ROLES.ADMIN), async (req, res) => {
  const version = fs.readFileSync(path.join(config.root, 'VERSION'), 'utf8').trim();
  const updates = await db.query('select * from system_updates order by started_at desc limit 1');
  res.send(layout(req, 'Configuracion', `<form method="post" action="/admin/settings/identity?_csrf=${req.csrfToken}" enctype="multipart/form-data" class="panel form-grid upload-form"><label>Nombre de Empresa<input name="company_name" value="${esc(app.locals.portalSettings.company_name)}"></label><label>Título del Portal<input name="portal_title" value="${esc(app.locals.portalSettings.portal_title)}"></label><label class="span">Logo<input type="file" name="file" accept="image/*"></label><progress hidden max="100"></progress><button class="primary span">Guardar identidad</button></form>
  <section class="panel"><h2>Actualizaciones</h2><p>Versión actual: ${esc(version)}</p><p>Último resultado: ${esc(updates.rows[0]?.status || 'Sin ejecuciones')}</p><form method="post" action="/admin/updates/check"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button>Buscar actualización</button></form><form method="post" action="/admin/updates/run"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="primary">Actualizar sistema</button></form></section>`));
});

app.post('/admin/settings/identity', requireLogin, requireRole(ROLES.ADMIN), upload.single('file'), async (req, res) => {
  await setSetting('company_name', req.body.company_name, req.user.id);
  await setSetting('portal_title', req.body.portal_title, req.user.id);
  if (req.file) {
    const attachment = await saveAttachment({ file: req.file, userId: req.user.id });
    await setSetting('logo_attachment_id', attachment.id, req.user.id);
  }
  await loadSettings(app);
  await audit(req.user.id, 'cambiar_identidad', 'system_settings', 'identity');
  res.redirect('/admin/settings');
});

app.post('/admin/updates/check', requireLogin, requireRole(ROLES.ADMIN), async (req, res) => {
  await db.query('insert into system_updates (status,current_version,available_version,started_by,log,finished_at) values ($1,$2,$3,$4,$5,now())', ['CHECKED', fs.readFileSync(path.join(config.root, 'VERSION'), 'utf8').trim(), 'Verificar repositorio remoto configurado', req.user.id, 'Chequeo registrado.']);
  res.redirect('/admin/settings');
});

app.post('/admin/updates/run', requireLogin, requireRole(ROLES.ADMIN), async (req, res) => {
  const running = await db.query("select 1 from system_updates where status='RUNNING' and finished_at is null");
  if (running.rowCount) { flash(req, 'error', 'Ya existe una actualización en ejecución.'); return res.redirect('/admin/settings'); }
  const row = await db.query('insert into system_updates (status,current_version,started_by,log) values ($1,$2,$3,$4) returning id', ['RUNNING', fs.readFileSync(path.join(config.root, 'VERSION'), 'utf8').trim(), req.user.id, 'Ejecute npm run update en el servidor para correr el flujo controlado.']);
  await audit(req.user.id, 'solicitar_actualizacion', 'system_updates', row.rows[0].id);
  flash(req, 'ok', 'Actualización registrada. El flujo seguro se ejecuta con el script documentado del servidor.');
  res.redirect('/admin/settings');
});

app.get('/health', (req, res) => res.json({ ok: true, version: fs.readFileSync(path.join(config.root, 'VERSION'), 'utf8').trim() }));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).send(layout(req, 'Error', '<section class="panel"><h1>No se pudo completar la acción.</h1><p>Reintente o contacte al administrador.</p></section>'));
});

module.exports = app;
