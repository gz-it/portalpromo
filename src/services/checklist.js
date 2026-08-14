const db = require('../db');

function summarizeChecklist(items) {
  if (!items.length) return { complete: 0, missing: 0, warnings: 0, total: 0, percentage: 0 };
  const complete = items.filter((item) => item.state !== 'missing').length;
  const missing = items.filter((item) => item.state === 'missing').length;
  const warnings = items.filter((item) => item.state === 'warning').length;
  return { complete, missing, warnings, total: items.length, percentage: Math.round((complete / items.length) * 100) };
}

function summarizeModuleCompleteness(items) {
  const grouped = {};
  for (const item of items.filter((entry) => entry.moduleKey !== 'aceptacion')) {
    if (!grouped[item.moduleKey]) grouped[item.moduleKey] = [];
    grouped[item.moduleKey].push(item);
  }
  return Object.fromEntries(Object.entries(grouped).map(([moduleKey, requirements]) => {
    const summary = summarizeChecklist(requirements);
    const state = summary.missing ? 'incomplete' : summary.warnings ? 'warning' : 'complete';
    return [moduleKey, { ...summary, state }];
  }));
}

async function buildEventChecklist(eventId) {
  const data = (await db.query(`select
    coalesce(nullif(trim(c.legal_name),''),'') legal_name,
    coalesce(nullif(trim(c.cuit),''),'') cuit,
    coalesce(nullif(trim(c.responsible),''),'') responsible,
    coalesce(nullif(trim(c.email),''),nullif(trim(c.phone),''),'') company_contact,
    (select count(*) from event_staff where event_id=$1) staff_count,
    (select count(*) from insurances where event_id=$1 and attachment_id is not null) insurance_count,
    (select count(*) from insurances where event_id=$1 and attachment_id is not null and (valid_until is null or valid_until >= current_date)) valid_insurance_count,
    (select count(*) from insurances where event_id=$1 and valid_until between current_date and current_date + interval '30 days') expiring_insurance_count,
    (select count(*) from permits where event_id=$1 and attachment_id is not null) permit_count,
    (select count(*) from mandatory_services where event_id=$1 and attachment_id is not null) service_count,
    (select count(*) from attachments where event_id=$1 and module_key='prensa' and deleted_at is null) press_count,
    (select count(*) from technical_documents where event_id=$1 and attachment_id is not null) technical_count,
    coalesce(nullif(trim(t.ticketing_name),''),'') ticketing_name,
    (select count(*) from ticket_sectors where event_id=$1) sector_count,
    (select count(*) from sponsors where event_id=$1 and attachment_id is not null) sponsor_count,
    coalesce(nullif(trim(t.sales_url),''),'') sales_url,
    (select count(*) from event_modules where event_id=$1 and module_key not in ('aceptacion') and status='APROBADO') approved_modules,
    (select count(*) from event_modules where event_id=$1 and module_key not in ('aceptacion')) reviewable_modules
    from events e left join event_companies c on c.event_id=e.id left join ticketing t on t.event_id=e.id where e.id=$1`, [eventId])).rows[0];

  const insuranceState = Number(data.valid_insurance_count) === 0 ? 'missing' : Number(data.expiring_insurance_count) > 0 ? 'warning' : 'complete';
  const items = [
    { moduleKey: 'identificacion', label: 'Razón social', state: data.legal_name ? 'complete' : 'missing' },
    { moduleKey: 'identificacion', label: 'CUIT de la empresa', state: data.cuit ? 'complete' : 'missing' },
    { moduleKey: 'identificacion', label: 'Responsable del evento', state: data.responsible ? 'complete' : 'missing' },
    { moduleKey: 'identificacion', label: 'Teléfono o email de contacto', state: data.company_contact ? 'complete' : 'missing' },
    { moduleKey: 'identificacion', label: 'Personal del evento', state: Number(data.staff_count) > 0 ? 'complete' : 'missing', detail: `${data.staff_count} personas` },
    { moduleKey: 'seguros', label: 'Póliza de seguro vigente', state: insuranceState, detail: insuranceState === 'warning' ? 'Vence dentro de 30 días' : `${data.insurance_count} pólizas` },
    { moduleKey: 'habilitaciones', label: 'Habilitación o permiso', state: Number(data.permit_count) > 0 ? 'complete' : 'missing' },
    { moduleKey: 'servicios', label: 'Servicio obligatorio documentado', state: Number(data.service_count) > 0 ? 'complete' : 'missing' },
    { moduleKey: 'prensa', label: 'Material de prensa', state: Number(data.press_count) > 0 ? 'complete' : 'missing' },
    { moduleKey: 'tecnica', label: 'Documentación técnica', state: Number(data.technical_count) > 0 ? 'complete' : 'missing' },
    { moduleKey: 'comercial', label: 'Ticketera comercial informada', state: data.ticketing_name ? 'complete' : 'missing' },
    { moduleKey: 'comercial', label: 'Sectores y capacidad', state: Number(data.sector_count) > 0 ? 'complete' : 'missing', detail: `${data.sector_count} sectores` },
    { moduleKey: 'sponsors', label: 'Sponsors y acuerdos', state: Number(data.sponsor_count) > 0 ? 'complete' : 'missing' },
    { moduleKey: 'ticketera', label: 'Enlace de venta', state: data.sales_url ? 'complete' : 'missing' },
    { moduleKey: 'aceptacion', label: 'Revisión administrativa completa', state: Number(data.approved_modules) === Number(data.reviewable_modules) ? 'complete' : 'missing', detail: `${data.approved_modules}/${data.reviewable_modules} módulos aprobados` },
  ];
  const documentItems = items.filter((item) => item.moduleKey !== 'aceptacion');
  const approved = Number(data.approved_modules);
  const reviewTotal = Number(data.reviewable_modules);
  return {
    items,
    ...summarizeChecklist(items),
    document: summarizeChecklist(documentItems),
    modules: summarizeModuleCompleteness(items),
    review: {
      approved,
      total: reviewTotal,
      percentage: reviewTotal ? Math.round((approved / reviewTotal) * 100) : 0,
    },
  };
}

module.exports = { buildEventChecklist, summarizeChecklist, summarizeModuleCompleteness };
