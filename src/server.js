const app = require('./app');
const config = require('./config');
const { startBackupScheduler } = require('./services/backups');

app.listen(config.port, config.env === 'production' ? '127.0.0.1' : undefined, () => {
  console.log(`Portal de Productores escuchando en http://localhost:${config.port}`);
  startBackupScheduler();
});
