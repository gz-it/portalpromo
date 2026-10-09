function pgEnvironment(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL invalida');
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    ...(url.searchParams.has('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}) };
}
module.exports = { pgEnvironment };
