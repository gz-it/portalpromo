const DEFAULT_WEEKDAYS = [1, 4];
const DEFAULT_TIME = '03:00';
const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

function normalizeWeekdays(values) {
  const source = Array.isArray(values) ? values : String(values || '').split(',');
  const days = [...new Set(source.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))];
  for (const fallback of DEFAULT_WEEKDAYS) {
    if (days.length >= 2) break;
    if (!days.includes(fallback)) days.push(fallback);
  }
  return days.slice(0, 2);
}

function normalizeEmails(values) {
  const source = Array.isArray(values) ? values : [values];
  return [...new Set(source.flatMap((value) => String(value || '').split(/[;,\s]+/)).map((email) => email.trim().toLowerCase()).filter(Boolean))].slice(0, 2);
}

function normalizeTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? value : DEFAULT_TIME;
}

function zonedParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const result = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dateKey = `${result.year}-${result.month}-${result.day}`;
  return {
    dateKey,
    weekday: new Date(`${dateKey}T12:00:00Z`).getUTCDay(),
    minutes: Number(result.hour) * 60 + Number(result.minute),
  };
}

function isBackupDue(settings, lastCreatedAt, now = new Date()) {
  const timeZone = settings.timezone || DEFAULT_TIMEZONE;
  const current = zonedParts(now, timeZone);
  const [hour, minute] = normalizeTime(settings.time).split(':').map(Number);
  if (current.minutes < hour * 60 + minute) return false;

  const weekdays = normalizeWeekdays(settings.weekdays);
  if (settings.frequency === 'weekly' && current.weekday !== weekdays[0]) return false;
  if (settings.frequency === 'twice_weekly' && !weekdays.includes(current.weekday)) return false;
  if (lastCreatedAt && zonedParts(lastCreatedAt, timeZone).dateKey === current.dateKey) return false;
  return true;
}

module.exports = {
  DEFAULT_TIME,
  DEFAULT_TIMEZONE,
  DEFAULT_WEEKDAYS,
  isBackupDue,
  normalizeEmails,
  normalizeTime,
  normalizeWeekdays,
};
