'use strict';

const { loadConfig } = require('./config/env');
const { connectDatabase } = require('./config/db');
const { S3Storage } = require('./integrations/s3/s3.storage');
const { createConverter } = require('./integrations/office/word.converter');
const { RadicadoService } = require('./modules/radicados/radicado.service');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const converter = createConverter(config);
  const { connection, models } = await connectDatabase(config);
  // Se inicia en paralelo con HTTP; los PDF no tienen que esperar al motor de Word.
  converter.warm().then(() => console.log('Conversor de Word preparado')).catch(error => console.warn('Conversor de Word:', error.code || 'NO_DISPONIBLE'));
  const storage = new S3Storage(config);
  const service = new RadicadoService({ models, storage, converter, config });
  const app = createApp({ service, config, ready: () => connection.readyState === 1 });
  const server = app.listen(config.PORT, config.HOST, () => console.log(`Radicados: http://${config.HOST}:${config.PORT}`));
  server.requestTimeout = 180000;
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 15000).unref();
    server.close(async () => {
      await connection.close();
      await converter.close();
      storage.client.destroy();
      clearTimeout(timer);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch(error => {
  // Evita imprimir URIs con credenciales, secretos o respuestas del proveedor.
  console.error('No se pudo iniciar Radicados:', error.name === 'ZodError' ? error.issues.map(x => x.path.join('.')).join(', ') : error.name);
  process.exitCode = 1;
});
