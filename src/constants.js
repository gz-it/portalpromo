const ROLES = {
  ADMIN: 'ADMINISTRADOR',
  PRODUCER: 'PRODUCTOR',
  MANAGER: 'GERENCIADORA',
  SYSTEMS: 'SISTEMAS',
};

const USER_STATUSES = ['PENDIENTE', 'ACTIVO', 'BLOQUEADO', 'DESHABILITADO'];
const MODULE_STATUSES = ['PENDIENTE', 'CARGADO', 'OBSERVADO', 'APROBADO'];

const MODULES = [
  ['identificacion', 'Datos del productor'],
  ['seguros', 'Seguros'],
  ['habilitaciones', 'Habilitaciones'],
  ['servicios', 'Servicios Obligatorios'],
  ['prensa', 'Prensa y difusión'],
  ['tecnica', 'Producción técnica'],
  ['comercial', 'Entradas y ventas'],
  ['sponsors', 'Marcas y sponsors'],
  ['aceptacion', 'Resumen y aprobación'],
  ['ticketera', 'Ticketera'],
].map(([key, name], index) => ({ key, name, order: index + 1 }));

module.exports = { ROLES, USER_STATUSES, MODULE_STATUSES, MODULES };
