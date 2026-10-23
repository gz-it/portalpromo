const db = require('../db');
const { ROLES } = require('../constants');
const { safelyQueue } = require('../services/security-alerts');

function mayManageUser(actor, targetRoles = [], requestedRole) {
  return Boolean(actor?.roles?.includes(ROLES.SYSTEMS)
    || (actor?.roles?.includes(ROLES.ADMIN) && !targetRoles.includes(ROLES.SYSTEMS) && requestedRole !== ROLES.SYSTEMS));
}

async function guardUserMutation(req, res, next) {
  if (!/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(req.params.id || '')) return res.status(404).send('Usuario no encontrado');
  const user = (await db.query(`select u.id,array_remove(array_agg(r.name),null) roles from users u
    left join user_roles ur on ur.user_id=u.id left join roles r on r.id=ur.role_id where u.id=$1 group by u.id`, [req.params.id])).rows[0];
  if (!user) return res.status(404).send('Usuario no encontrado');
  if (!mayManageUser(req.user, user.roles, req.body?.role)) {
    await safelyQueue('PRIVILEGE_DENIED', { actorId: req.user?.id, targetId: user.id, ip: req.ip });
    return res.status(403).send('Esta cuenta o permiso solo puede gestionarse desde Sistemas.');
  }
  next();
}

module.exports = { mayManageUser, guardUserMutation };
