const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  console.log(`Portal de Productores escuchando en http://localhost:${config.port}`);
});
