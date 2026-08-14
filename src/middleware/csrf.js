const crypto = require('crypto');

function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  req.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.body?._csrf || req.query?._csrf || req.headers['x-csrf-token'];
  if (token !== req.session.csrfToken) return res.status(403).send('Sesion expirada. Vuelva a intentar.');
  next();
}

module.exports = { csrf };
