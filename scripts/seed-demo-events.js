require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const PDFDocument = require('pdfkit');
const { pool } = require('../src/db');
const config = require('../src/config');
const { MODULES } = require('../src/constants');

const demoEvents = [
  {
    name: 'Tini', artist: 'Tini', venue: 'Movistar Arena', city: 'CABA', province: 'Buenos Aires',
    showDate: '2026-11-14', activeModules: 8, approvedModules: 5, observed: true,
    company: 'TINI Producciones SA', cuit: '30-71824561-9', responsible: 'Lucia Fernandez',
    staff: ['Lucia', 'Fernandez', '27-31824561-4', 'Productora ejecutiva'], ticketing: 'Entrada Uno',
  },
  {
    name: 'Megadeth', artist: 'Megadeth', venue: 'Estadio Huracan', city: 'CABA', province: 'Buenos Aires',
    showDate: '2026-08-20', activeModules: 5, approvedModules: 2, observed: true,
    company: 'Metal Shows SRL', cuit: '30-70984521-2', responsible: 'Martin Acosta',
    staff: ['Martin', 'Acosta', '20-28984521-7', 'Jefe de produccion'], ticketing: 'All Access',
  },
  {
    name: 'Guns N Roses', artist: 'Guns N Roses', venue: 'Estadio River Plate', city: 'CABA', province: 'Buenos Aires',
    showDate: '2026-12-05', activeModules: 3, approvedModules: 1, observed: false,
    company: 'Rock Live Argentina SA', cuit: '30-71667442-8', responsible: 'Carolina Mendez',
    staff: ['Carolina', 'Mendez', '27-33667442-5', 'Coordinadora general'], ticketing: 'LivePass',
  },
];

function pdfBuffer(eventName, moduleName) {
  return new Promise((resolve) => {
    const document = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.fontSize(20).text(`Documento demo - ${eventName}`);
    document.moveDown().fontSize(13).text(`Modulo: ${moduleName}`);
    document.moveDown().fontSize(11).text('Archivo generado para visualizar el expediente administrativo de prueba.');
    document.end();
  });
}

async function ensureAttachment(client, event, moduleKey, userId) {
  const originalName = `${event.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${moduleKey}.pdf`;
  const existing = await client.query(
    'select * from attachments where event_id=$1 and module_key=$2 and original_name=$3 and deleted_at is null limit 1',
    [event.id, moduleKey, originalName],
  );
  if (existing.rows[0]) return existing.rows[0];

  const internalName = `${randomUUID()}-${originalName}`;
  const eventDir = path.join(config.storagePath, event.id);
  fs.mkdirSync(eventDir, { recursive: true });
  const contents = await pdfBuffer(event.name, MODULES.find((item) => item.key === moduleKey).name);
  fs.writeFileSync(path.join(eventDir, internalName), contents);
  const inserted = await client.query(
    `insert into attachments (event_id,module_key,original_name,internal_name,storage_key,mime_type,size_bytes,uploaded_by)
     values ($1,$2,$3,$4,$5,'application/pdf',$6,$7) returning *`,
    [event.id, moduleKey, originalName, internalName, `${event.id}/${internalName}`, contents.length, userId],
  );
  return inserted.rows[0];
}

async function ensureModuleData(client, event, moduleKey, userId) {
  if (moduleKey === 'identificacion') return;
  if (moduleKey === 'comercial') {
    await client.query(
      `insert into ticketing (event_id,ticketing_name,contact,observations) values ($1,$2,$3,$4)
       on conflict (event_id) do update set ticketing_name=excluded.ticketing_name,contact=excluded.contact,observations=excluded.observations,updated_at=now()`,
      [event.id, event.ticketing, `${event.responsible} - 11 5555 0101`, 'Configuracion comercial de demostracion'],
    );
    await client.query(
      `insert into ticket_sectors (event_id,name,capacity,price,observation)
       select $1,'Campo General',8500,45000,'Sector demo' where not exists
       (select 1 from ticket_sectors where event_id=$1 and name='Campo General')`, [event.id],
    );
    await client.query(
      `insert into sales_phases (event_id,name,date_from,date_to)
       select $1,'Preventiva','2026-06-01','2026-06-15' where not exists
       (select 1 from sales_phases where event_id=$1 and name='Preventiva')`, [event.id],
    );
    return;
  }

  const attachment = await ensureAttachment(client, event, moduleKey, userId);
  const inserts = {
    seguros: [`insert into insurances (event_id,type,valid_until,observation,attachment_id)
      select $1,'Responsabilidad Civil','2027-12-31','Poliza demo vigente',$2 where not exists
      (select 1 from insurances where attachment_id=$2)`, [event.id, attachment.id]],
    habilitaciones: [`insert into permits (event_id,type,reference_number,observation,attachment_id)
      select $1,'Habilitacion municipal','EXP-DEMO-2026','En revision municipal',$2 where not exists
      (select 1 from permits where attachment_id=$2)`, [event.id, attachment.id]],
    servicios: [`insert into mandatory_services (event_id,category,provider,observation,attachment_id)
      select $1,'Servicio Medico / Ambulancia','Emergencias Demo','Cobertura confirmada',$2 where not exists
      (select 1 from mandatory_services where attachment_id=$2)`, [event.id, attachment.id]],
    prensa: [`insert into assets (event_id,category,observation,attachment_id)
      select $1,'Material de prensa','Kit de prensa para aprobacion',$2 where not exists
      (select 1 from assets where attachment_id=$2)`, [event.id, attachment.id]],
    tecnica: [`insert into technical_documents (event_id,category,observation,attachment_id)
      select $1,'Rider Tecnico','Version preliminar del rider',$2 where not exists
      (select 1 from technical_documents where attachment_id=$2)`, [event.id, attachment.id]],
    sponsors: [`insert into sponsors (event_id,brand,agreement_type,description,observation,attachment_id)
      select $1,'Marca Demo','Sponsor principal','Presencia en pantallas','Pendiente de arte final',$2 where not exists
      (select 1 from sponsors where attachment_id=$2)`, [event.id, attachment.id]],
  };
  if (inserts[moduleKey]) await client.query(...inserts[moduleKey]);
}

async function seedEvent(client, spec, userId) {
  let event = (await client.query(
    'select * from events where owner_user_id=$1 and lower(name)=lower($2) order by created_at limit 1',
    [userId, spec.name],
  )).rows[0];
  if (!event) {
    event = (await client.query(
      `insert into events (owner_user_id,created_by,name,artist,venue,city,province,status)
       values ($1,$1,$2,$3,$4,$5,$6,'EN_CARGA') returning *`,
      [userId, spec.name, spec.artist, spec.venue, spec.city, spec.province],
    )).rows[0];
  } else {
    event = (await client.query(
      `update events set artist=$2,venue=$3,city=$4,province=$5,status='EN_CARGA',updated_at=now()
       where id=$1 returning *`, [event.id, spec.artist, spec.venue, spec.city, spec.province],
    )).rows[0];
  }
  Object.assign(event, spec);

  await client.query('delete from event_dates where event_id=$1', [event.id]);
  await client.query('insert into event_dates (event_id,show_date) values ($1,$2)', [event.id, spec.showDate]);
  for (const module of MODULES) {
    await client.query(
      `insert into event_modules (event_id,module_key,module_name) values ($1,$2,$3)
       on conflict (event_id,module_key) do update set module_name=excluded.module_name`,
      [event.id, module.key, module.name],
    );
  }

  await client.query(
    `insert into event_companies (event_id,legal_name,cuit,responsible,phone,email) values ($1,$2,$3,$4,$5,$6)
     on conflict (event_id) do update set legal_name=excluded.legal_name,cuit=excluded.cuit,responsible=excluded.responsible,
       phone=excluded.phone,email=excluded.email,updated_at=now()`,
    [event.id, spec.company, spec.cuit, spec.responsible, '11 5555 0100', `${spec.name.toLowerCase().replace(/\s+/g, '.')}@demo.local`],
  );
  await client.query(
    `insert into event_staff (event_id,first_name,last_name,cuit,role_title,company,phone,email)
     select $1,$2,$3,$4,$5,$6,'11 5555 0199',$7 where not exists
     (select 1 from event_staff where event_id=$1 and cuit=$4)`,
    [event.id, ...spec.staff, spec.company, `${spec.staff[0].toLowerCase()}@demo.local`],
  );

  const activeKeys = MODULES.slice(0, spec.activeModules).map((module) => module.key);
  for (const [index, module] of MODULES.entries()) {
    let status = 'PENDIENTE';
    if (activeKeys.includes(module.key)) {
      status = index < spec.approvedModules ? 'APROBADO' : (spec.observed && index === spec.approvedModules ? 'OBSERVADO' : 'CARGADO');
      await ensureModuleData(client, event, module.key, userId);
    }
    await client.query('update event_modules set status=$3,updated_at=now() where event_id=$1 and module_key=$2', [event.id, module.key, status]);
    if (status !== 'PENDIENTE') {
      await client.query(
        `insert into module_status_history (event_id,module_key,previous_status,new_status,observation,created_by)
         select $1,$2,'PENDIENTE',$3,'Datos de demostracion',$4 where not exists
         (select 1 from module_status_history where event_id=$1 and module_key=$2 and observation='Datos de demostracion')`,
        [event.id, module.key, status, userId],
      );
    }
  }
  return `${spec.name}: ${spec.activeModules * 10}% completado`;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const producer = (await client.query("select id from users where username='productor' limit 1")).rows[0];
    if (!producer) throw new Error('No existe el usuario productor. Ejecute primero npm run seed:demo.');
    const results = [];
    for (const event of demoEvents) results.push(await seedEvent(client, event, producer.id));
    await client.query('commit');
    console.log(`Eventos demo listos: ${results.join(', ')}.`);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

main().then(() => pool.end()).catch((error) => {
  console.error(error.message);
  pool.end().finally(() => process.exit(1));
});
