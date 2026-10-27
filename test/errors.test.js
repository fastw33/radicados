'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const { createConverter } = require('../src/integrations/office/word.converter');
const { S3Storage } = require('../src/integrations/s3/s3.storage');
const { testConfig, sampleDocx } = require('./helpers');

function preparationRequest(prepare, logger = { error() {} }) {
  const config = testConfig();
  const app = createApp({ config, service: { prepare }, logger });
  const token = jwt.sign({ id_usuario: 'cuenta', id_personal: 'persona', permisos: { radicadosEmitir: true } }, config.JWT_SECRET, { expiresIn: '1h' });
  return request(app).post('/api/v1/preparaciones')
    .set('Authorization', `Bearer ${token}`)
    .attach('documento', sampleDocx(), 'carta.docx');
}

test('Word sin motor devuelve la causa al frontend y conserva la referencia de atención', async () => {
  const convert = createConverter(testConfig(), async () => {
    throw Object.assign(new Error('ruta local del servidor'), { code: 'ENOENT' });
  });
  const response = await preparationRequest(file => convert(file.buffer));
  assert.equal(response.status, 503);
  assert.equal(response.body.error.codigo, 'CONVERSOR_NO_DISPONIBLE');
  assert.match(response.body.error.mensaje, /Puedes cargar un PDF exportado desde Word/);
  assert.equal(response.body.requestId, response.headers['x-request-id']);
  assert.doesNotMatch(JSON.stringify(response.body), /ruta local del servidor/);
});

test('los errores internos inesperados siguen ocultando información técnica', async () => {
  const response = await preparationRequest(async () => { throw new Error('credencial-interna-de-prueba'); });
  assert.equal(response.status, 500);
  assert.equal(response.body.error.mensaje, 'No se pudo completar la operación');
  assert.doesNotMatch(JSON.stringify(response.body), /credencial-interna-de-prueba/);
});

test('S3 sin conexión devuelve un mensaje útil y registra la dependencia sin exponer secretos', async () => {
  const logs = [];
  const storage = new S3Storage(testConfig(), { async send() {
    throw Object.assign(new Error('credencial-interna-de-prueba'), { code: 'ECONNREFUSED' });
  } });
  const response = await preparationRequest(file => storage.put('radicados/prueba.docx', file.buffer, file.mimetype, file.originalname), { error(line) { logs.push(JSON.parse(line)); } });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.codigo, 'ALMACENAMIENTO_NO_DISPONIBLE');
  assert.match(response.body.error.mensaje, /almacenamiento de documentos/);
  assert.deepEqual(logs, [{ requestId: response.body.requestId, code: 'ALMACENAMIENTO_NO_DISPONIBLE', name: 'Error', servicio: 'S3', operacion: 'PutObjectCommand', causa: 'ECONNREFUSED' }]);
  assert.doesNotMatch(JSON.stringify({ logs, body: response.body }), /credencial-interna-de-prueba/);
});
