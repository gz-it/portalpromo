const XLSX = require('xlsx');

const HEADERS = ['Nombre', 'Apellido', 'CUIT', 'Funcion / Cargo', 'Empresa', 'Telefono', 'Email'];

function workbookTemplateBuffer() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([HEADERS]);
  XLSX.utils.book_append_sheet(wb, ws, 'Personal');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function validCuit(value) {
  return /^\d{2}-?\d{8}-?\d$/.test(String(value || '').trim());
}

function parseStaff(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const people = [];
  const errors = [];
  rows.forEach((row, index) => {
    const line = index + 2;
    const person = {
      first_name: row.Nombre || row.nombre,
      last_name: row.Apellido || row.apellido,
      cuit: row.CUIT || row.cuit,
      role_title: row['Funcion / Cargo'] || row['Función / Cargo'] || row.Funcion || row.Cargo,
      company: row.Empresa || '',
      phone: row.Telefono || row.Teléfono || '',
      email: row.Email || '',
    };
    for (const [field, label] of [['first_name', 'Nombre'], ['last_name', 'Apellido'], ['cuit', 'CUIT'], ['role_title', 'Funcion / Cargo']]) {
      if (!String(person[field] || '').trim()) errors.push({ row: line, field: label, problem: `Falta ${label}` });
    }
    if (person.cuit && !validCuit(person.cuit)) errors.push({ row: line, field: 'CUIT', problem: 'CUIT invalido' });
    people.push(person);
  });
  const errorRows = new Set(errors.map((e) => e.row));
  return { people, errors, total: people.length, valid: people.length - errorRows.size, invalid: errorRows.size };
}

module.exports = { workbookTemplateBuffer, parseStaff };
