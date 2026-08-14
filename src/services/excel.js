const ExcelJS = require('exceljs');

const HEADERS = ['Nombre', 'Apellido', 'CUIT', 'Funcion / Cargo', 'Empresa', 'Telefono', 'Email'];

async function workbookTemplateBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Personal');
  sheet.addRow(HEADERS);
  sheet.getRow(1).font = { bold: true };
  sheet.columns = [22, 22, 18, 28, 24, 18, 30].map((width) => ({ width }));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function validCuit(value) {
  return /^\d{2}-?\d{8}-?\d$/.test(String(value || '').trim());
}

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function cellText(cell) {
  return String(cell?.text ?? cell?.value ?? '').trim();
}

async function parseStaff(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('La planilla no contiene hojas.');

  const columns = new Map();
  sheet.getRow(1).eachCell((cell, column) => columns.set(normalizeHeader(cellText(cell)), column));
  const value = (row, ...headers) => {
    const header = headers.find((candidate) => columns.has(candidate));
    return header ? cellText(row.getCell(columns.get(header))) : '';
  };

  const people = [];
  const errors = [];
  sheet.eachRow((row, line) => {
    if (line === 1) return;
    const person = {
      first_name: value(row, 'nombre'),
      last_name: value(row, 'apellido'),
      cuit: value(row, 'cuit'),
      role_title: value(row, 'funcion / cargo', 'funcion', 'cargo'),
      company: value(row, 'empresa'),
      phone: value(row, 'telefono'),
      email: value(row, 'email'),
    };
    if (Object.values(person).every((item) => !item)) return;

    for (const [field, label] of [['first_name', 'Nombre'], ['last_name', 'Apellido'], ['cuit', 'CUIT'], ['role_title', 'Funcion / Cargo']]) {
      if (!person[field]) errors.push({ row: line, field: label, problem: `Falta ${label}` });
    }
    if (person.cuit && !validCuit(person.cuit)) errors.push({ row: line, field: 'CUIT', problem: 'CUIT invalido' });
    people.push(person);
  });

  const errorRows = new Set(errors.map((error) => error.row));
  return { people, errors, total: people.length, valid: people.length - errorRows.size, invalid: errorRows.size };
}

module.exports = { workbookTemplateBuffer, parseStaff };
