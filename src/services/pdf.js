const PDFDocument = require('pdfkit');
const db = require('../db');

function collect(doc) {
  const chunks = [];
  return new Promise((resolve) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.end();
  });
}

function line(doc, label, value) {
  doc.font('Helvetica-Bold').text(`${label}: `, { continued: true }).font('Helvetica').text(value || '-');
}

async function modulePdf(event, moduleKey, settings = {}) {
  const doc = new PDFDocument({ margin: 48 });
  doc.fontSize(18).text(settings.portal_title || 'Portal de Productores');
  doc.moveDown(0.5).fontSize(14).text(`${event.name} - ${moduleKey}`);
  doc.moveDown();
  if (moduleKey === 'identificacion') {
    const company = (await db.query('select * from event_companies where event_id=$1', [event.id])).rows[0] || {};
    line(doc, 'Razon Social', company.legal_name);
    line(doc, 'CUIT', company.cuit);
    line(doc, 'Responsable', company.responsible);
    line(doc, 'Telefono', company.phone);
    line(doc, 'Email', company.email);
    doc.moveDown().font('Helvetica-Bold').text('Personal');
    const staff = await db.query('select * from event_staff where event_id=$1 order by last_name, first_name', [event.id]);
    staff.rows.forEach((p) => line(doc, `${p.last_name}, ${p.first_name}`, `${p.cuit} - ${p.role_title} - ${p.company || ''}`));
  } else {
    const tables = {
      seguros: 'select type, valid_until, observation from insurances where event_id=$1',
      habilitaciones: 'select type, reference_number, observation from permits where event_id=$1',
      servicios: 'select category, provider, observation from mandatory_services where event_id=$1',
      comercial: 'select ticketing_name, contact, observations, sales_url from ticketing where event_id=$1',
      sponsors: 'select brand, agreement_type, description, observation from sponsors where event_id=$1',
      ticketera: 'select ticketing_name, sales_url, sales_date, sales_observations from ticketing where event_id=$1',
    };
    if (tables[moduleKey]) {
      const rows = await db.query(tables[moduleKey], [event.id]);
      rows.rows.forEach((row) => { Object.entries(row).forEach(([k, v]) => line(doc, k, v)); doc.moveDown(0.5); });
    } else {
      doc.text('Este modulo contiene principalmente archivos originales adjuntos.');
    }
  }
  return collect(doc);
}

module.exports = { modulePdf };
