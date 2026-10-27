'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { authenticate } = require('./middlewares/auth.middleware');
const { requestContext } = require('./middlewares/requestContext.middleware');
const { requireDatabaseReady } = require('./middlewares/databaseReady.middleware');
const { notFound } = require('./middlewares/notFound');
const { createErrorHandler } = require('./middlewares/errorHandler');
const { createRadicadoRouter } = require('./modules/radicados/radicado.routes');
const { HttpError } = require('./utils/httpError');

function createApp({ service, config, ready = () => true, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  // Coolify: un salto si Traefik es el único proxy y no se publica el puerto directo.
  app.set('trust proxy', config.TRUST_PROXY_HOPS || 0);
  app.use(helmet());
  app.use(cors({
    origin(origin, done) {
      if (!origin || config.corsOrigins.includes(origin)) return done(null, true);
      done(new HttpError(403, 'ORIGEN_NO_PERMITIDO', 'Origen no permitido'));
    },
    exposedHeaders: ['Content-Disposition', 'Location', 'X-Radicado-Id', 'X-Radicado-Consecutivo', 'X-Request-Id'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'Accept'],
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  }));
  app.use(requestContext);
  app.get('/health', (req, res) => res.json({ status: 'up' }));
  app.get('/ready', (req, res) => res.status(ready() ? 200 : 503).json({ ready: ready() }));
  app.use('/api', rateLimit({ windowMs: 60000, limit: config.RATE_LIMIT_PER_MINUTE || 90, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use('/api', authenticate(config));
  app.use('/api', express.json({ limit: '64kb' }));
  app.use('/api', requireDatabaseReady(ready));
  app.use('/api/v1', createRadicadoRouter({ service, config }));
  app.use(notFound);
  app.use(createErrorHandler(logger));
  return app;
}
module.exports = { createApp };
