const db = require('../db');
const { ROLES } = require('../constants');

async function attachUser(req, res, next) {
  if (!req.session.userId) return next();
  const result = await db.query(
    `select u.*, array_remove(array_agg(r.name), null) as roles
     from users u
     left join user_roles ur on ur.user_id=u.id
     left join roles r on r.id=ur.role_id
     where u.id=$1
     group by u.id`,
    [req.session.userId],
  );
  req.user = result.rows[0] || null;
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.status !== 'ACTIVO') {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.some((role) => req.user.roles.includes(role))) return res.status(403).send('Acceso denegado');
    next();
  };
}

function isAdmin(user) {
  return user?.roles?.includes(ROLES.ADMIN);
}

function isManager(user) {
  return user?.roles?.includes(ROLES.MANAGER);
}

function canViewEventFile(user) {
  return isAdmin(user) || isManager(user);
}

function canDownloadEventFile(user) {
  return isAdmin(user);
}

function canEditEventContent(user, event) {
  return user?.roles?.includes(ROLES.PRODUCER) && event?.owner_user_id === user?.id;
}

function canReviewEventContent(user) {
  return isAdmin(user) || isManager(user);
}

function canDeleteEventFile(user, event) {
  return canEditEventContent(user, event);
}

async function loadAuthorizedEvent(req, res, next) {
  const id = req.params.eventId || req.params.id;
  const eventResult = await db.query(
    `select e.*, u.first_name || ' ' || u.last_name as owner_name
     from events e join users u on u.id=e.owner_user_id where e.id=$1`,
    [id],
  );
  const event = eventResult.rows[0];
  if (!event) return res.status(404).send('Evento no encontrado');
  if (isAdmin(req.user) || event.owner_user_id === req.user.id) {
    req.event = event;
    return next();
  }
  if (isManager(req.user)) {
    const access = await db.query('select 1 from event_manager_access where event_id=$1 and user_id=$2', [event.id, req.user.id]);
    if (access.rowCount) {
      req.event = event;
      return next();
    }
  }
  return res.status(403).send('Acceso denegado');
}

module.exports = {
  attachUser,
  requireLogin,
  requireRole,
  loadAuthorizedEvent,
  isAdmin,
  isManager,
  canViewEventFile,
  canDownloadEventFile,
  canEditEventContent,
  canReviewEventContent,
  canDeleteEventFile,
};
