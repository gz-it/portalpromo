function safeHandler(handler) {
  if (Array.isArray(handler)) return handler.map(safeHandler);
  if (typeof handler !== 'function' || handler.length === 4) return handler;
  return function guardedHandler(req, res, next) {
    try {
      return Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      return next(error);
    }
  };
}

// Express 4 does not forward rejected handler promises to error middleware.
function safeRoutes(app) {
  return Object.fromEntries(['use', 'get', 'post'].map(method => [method, (...args) =>
    app[method](...args.map(safeHandler))]));
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  let status = 500;
  let message = 'No se pudo completar la accion. Reintente o contacte al administrador.';
  if (error.code === 'LIMIT_FILE_SIZE' || error.status === 413) {
    status = 413;
    message = 'El archivo o la solicitud supera el limite permitido.';
  } else if (error.status === 503) {
    status = 503;
    message = 'No hay espacio disponible para recibir archivos. Contacte al administrador.';
  } else if (error.status === 400 || ['22P02', '22003', '22007', '22008', 'LIMIT_UNEXPECTED_FILE'].includes(error.code)) {
    status = 400;
    message = 'Los datos enviados no son validos. Revise e intente nuevamente.';
  }
  if (status === 500) console.error('Error de solicitud:', { name: error.name, code: error.code });
  res.status(status).type('text/plain').send(message);
}

module.exports = { safeHandler, safeRoutes, errorHandler };
