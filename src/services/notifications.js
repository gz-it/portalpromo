const db = require('../db');
const { MODULES, ROLES } = require('../constants');

function moduleName(moduleKey) {
  return MODULES.find((module) => module.key === moduleKey)?.name || moduleKey;
}

function reviewNotificationMessage(moduleKey, status, comment) {
  const detail = comment ? ` Comentario: ${comment}` : '';
  return `${moduleName(moduleKey)} fue marcado como ${status}.${detail}`;
}

async function notifyAdminsOfProducerUpdate(eventId, moduleKey, actorId) {
  const context = (await db.query(`
    select e.name event_name,u.first_name || ' ' || u.last_name actor_name,
      exists(select 1 from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=u.id and r.name=$3) is_producer
    from events e join users u on u.id=$2 where e.id=$1`, [eventId, actorId, ROLES.PRODUCER])).rows[0];
  if (!context?.is_producer) return;
  await db.query(`
    insert into notifications (user_id,event_id,type,title,message,link)
    select distinct u.id,$1,'NUEVA_CARGA',$2,$3,$4
    from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id
    where r.name=$5 and u.status='ACTIVO'`, [
    eventId,
    `Nueva carga en ${context.event_name}`,
    `${context.actor_name} actualizo ${moduleName(moduleKey)}.`,
    `/events/${eventId}/modules/${moduleKey}`,
    ROLES.ADMIN,
  ]);
}

async function notifyEventOwner(eventId, type, title, message, link) {
  await db.query(`
    insert into notifications (user_id,event_id,type,title,message,link)
    select owner_user_id,id,$2,$3,$4,$5 from events where id=$1`,
  [eventId, type, title, message, link]);
}

module.exports = { notifyAdminsOfProducerUpdate, notifyEventOwner, reviewNotificationMessage };
