const ROLES = {
  ADMIN: 'ADMINISTRADOR',
  PRODUCER: 'PRODUCTOR',
  MANAGER: 'GERENCIADORA',
};

const USER_STATUSES = ['PENDIENTE', 'ACTIVO', 'BLOQUEADO', 'DESHABILITADO'];
const MODULE_STATUSES = ['PENDIENTE', 'CARGADO', 'OBSERVADO', 'APROBADO'];

const MODULES = [
  ['identificacion', 'Identificacion'],
  ['seguros', 'Seguros'],
  ['habilitaciones', 'Habilitaciones'],
  ['servicios', 'Servicios Obligatorios'],
  ['prensa', 'Prensa & Assets'],
  ['tecnica', 'Produccion Tecnica'],
  ['comercial', 'Comercial & Ticketing'],
  ['sponsors', 'Sponsors & Marcas'],
  ['aceptacion', 'Aceptacion de Contenido'],
  ['ticketera', 'Ticketera'],
].map(([key, name], index) => ({ key, name, order: index + 1 }));

module.exports = { ROLES, USER_STATUSES, MODULE_STATUSES, MODULES };
