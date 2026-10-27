'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config/env');
const { testConfig } = require('./helpers');

test('el límite detrás de un proxy separa clientes y no acepta la IP falsa de la izquierda', async () => {
  const app = createApp({ service: {}, config: { ...testConfig(), TRUST_PROXY_HOPS: 1, RATE_LIMIT_PER_MINUTE: 1 } });
  assert.equal(app.get('trust proxy'), 1);
  const call = forwarded => request(app).get('/api/v1/radicados').set('X-Forwarded-For', forwarded);
  assert.equal((await call('198.51.100.10')).status, 401);
  assert.equal((await call('198.51.100.10')).status, 429);
  assert.equal((await call('198.51.100.11')).status, 401);
  assert.equal((await call('203.0.113.99, 198.51.100.10')).status, 429);
});

test('el acceso directo ignora IPs reenviadas al contabilizar el límite', async context => {
  // Sin proxy, la biblioteca debe avisar sobre cabeceras inesperadas y usar la conexión.
  context.mock.method(console, 'error', () => {});
  const app = createApp({ service: {}, config: { ...testConfig(), RATE_LIMIT_PER_MINUTE: 1 } });
  const call = forwarded => request(app).get('/api/v1/radicados').set('X-Forwarded-For', forwarded);
  assert.equal((await call('198.51.100.10')).status, 401);
  assert.equal((await call('198.51.100.11')).status, 429);
});

test('configura saltos acotados y rechaza confianza ilimitada o valores inválidos', () => {
  const env = { MONGO_URI: 'mongodb://127.0.0.1/radicados', JWT_SECRET: 'clave-ficticia-solo-prueba', MARK_SECRET: 'a'.repeat(64), S3_BUCKET: 'prueba', AWS_REGION: 'us-east-1' };
  assert.equal(loadConfig(env).TRUST_PROXY_HOPS, 0);
  assert.equal(loadConfig({ ...env, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS, 1);
  for (const value of ['true', '-1', '1.5', '11', 'abc']) {
    assert.throws(() => loadConfig({ ...env, TRUST_PROXY_HOPS: value }));
  }
});
