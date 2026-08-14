const { MODULES, ROLES } = require('./constants');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function attrs(values) {
  return Object.entries(values).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
}

function optionList(items, selected) {
  return items.map((x) => `<option value="${esc(x)}" ${x === selected ? 'selected' : ''}>${esc(x)}</option>`).join('');
}

function layout(req, title, body, options = {}) {
  const settings = req.app.locals.portalSettings || {};
  const user = req.user;
  const flash = req.session.flash;
  delete req.session.flash;
  const nav = user ? `
    <header class="topbar">
      <a class="brand" href="/dashboard">${settings.logo_attachment_id ? '<img src="/branding/logo" alt="Logo">' : '<span class="brand-mark">PP</span>'}<span>${esc(settings.portal_title || 'Portal de Productores')}</span></a>
      <nav class="top-actions">
        <a class="notification-link" href="/notifications">Notificaciones${user.unread_notifications ? `<span>${user.unread_notifications}</span>` : ''}</a>
        ${user.roles.includes(ROLES.ADMIN) ? `<span class="user-name">${esc(user.first_name)} ${esc(user.last_name)}</span>` : `<a href="/profile">${esc(user.first_name)} ${esc(user.last_name)}</a>`}
        ${user.roles.includes(ROLES.ADMIN) ? '<a href="/admin">Administracion</a>' : ''}
        <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button>Salir</button></form>
      </nav>
    </header>` : '';
  return `<!doctype html>
  <html lang="es"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)} - ${esc(settings.portal_title || 'Portal de Productores')}</title>
    <link rel="stylesheet" href="/public/css/app.css">
  </head><body>
    ${nav}
    <main class="${options.narrow ? 'page narrow' : 'page'}">
      ${flash ? `<div class="toast ${flash.type || 'ok'}">${esc(flash.message)}</div>` : ''}
      ${body}
    </main>
    <script>window.csrfToken=${JSON.stringify(req.csrfToken || '')}</script>
    <script src="/public/js/app.js"></script>
  </body></html>`;
}

function authPage(req, mode = 'login') {
  const settings = req.app.locals.portalSettings || {};
  const forms = {
    login: `<form method="post" action="/login" class="panel form-stack">
      <input type="hidden" name="_csrf" value="${req.csrfToken}">
      <label>Usuario o email<input name="login" required autocomplete="username"></label>
      <label>Contraseña<input name="password" type="password" required autocomplete="current-password"></label>
      <button class="primary">Ingresar</button>
      <p><a href="/register">Registrarse</a> · <a href="/forgot">Recuperar contraseña</a></p>
    </form>`,
    register: `<form method="post" action="/register" class="panel form-grid">
      <input type="hidden" name="_csrf" value="${req.csrfToken}">
      ${['Nombre:first_name','Apellido:last_name','Email:email','Teléfono:phone','Usuario:username'].map((x) => { const [l,n]=x.split(':'); return `<label>${l}<input name="${n}" required></label>`; }).join('')}
      <label>Contraseña<input name="password" type="password" required minlength="8"></label>
      <label>Confirmar contraseña<input name="confirm_password" type="password" required minlength="8"></label>
      <button class="primary span">Crear cuenta</button><p class="span"><a href="/login">Ya tengo cuenta</a></p>
    </form>`,
    forgot: `<form method="post" action="/forgot" class="panel form-stack">
      <input type="hidden" name="_csrf" value="${req.csrfToken}">
      <label>Email<input name="email" type="email" required></label>
      <button class="primary">Enviar recuperacion</button>
      <p><a href="/login">Volver al login</a></p>
    </form>`,
  };
  return layout(req, 'Acceso', `<section class="auth">
    <div><div class="auth-mark">${settings.logo_attachment_id ? '<img src="/branding/logo" alt="Logo">' : 'PP'}</div>
    <h1>${esc(settings.company_name || 'Portal de Productores')}</h1><p>${esc(settings.portal_title || 'Gestion documental de eventos')}</p></div>
    ${forms[mode]}
  </section>`, { narrow: true });
}

function eventHeader(event, activeKey, options = {}) {
  const overview = options.overviewHref ? `<a class="module-pill ${activeKey ? '' : 'active'}" href="${options.overviewHref}"><span>•</span><b>Resumen</b><small>EXPEDIENTE</small></a>` : '';
  const pills = MODULES.map((m) => {
    const status = event.module_statuses?.[m.key] || 'PENDIENTE';
    const load = event.module_completeness?.[m.key];
    const loadLabel = load?.state === 'complete' ? 'Completa' : load?.state === 'warning' ? 'Completa con alerta' : 'Incompleta';
    const reviewLabel = { APROBADO: 'Aprobada', OBSERVADO: 'Observada', CARGADO: 'Sin revisar', PENDIENTE: 'Sin revisar' }[status];
    const icon = status === 'APROBADO' ? '✓' : status === 'OBSERVADO' ? '!' : load?.state === 'complete' ? '●' : '○';
    return `<a class="module-pill ${activeKey === m.key ? 'active' : ''} ${status.toLowerCase()}" href="/events/${event.id}/modules/${m.key}">
      <span>${icon}</span><b>${esc(m.name)}</b><small class="module-state"><span class="load-${load?.state || 'incomplete'}">Carga: ${esc(loadLabel)}</span><span class="review-${status.toLowerCase()}">Revisión: ${esc(reviewLabel)}</span></small></a>`;
  }).join('');
  return `<section class="event-head"><a href="${options.backHref || '/dashboard'}">← ${esc(options.backLabel || 'Mis eventos')}</a><h1>${esc(event.name)}</h1><p>${esc(event.artist)} · ${esc(event.venue)} · ${esc(event.city)}</p></section><nav class="module-bar">${overview}${pills}</nav>`;
}

function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${headers.length}">Sin datos.</td></tr>`}</tbody></table></div>`;
}

module.exports = { esc, attrs, optionList, layout, authPage, eventHeader, table };
