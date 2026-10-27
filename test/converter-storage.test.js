'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { validateDocx, createConverter } = require('../src/integrations/office/word.converter');
const { S3Storage, sha256 } = require('../src/integrations/s3/s3.storage');
const { testConfig, sampleDocx, samplePdf, zipEntries } = require('./helpers');

test('valida un DOCX y rechaza ZIPs comunes y macros', async () => {
  await validateDocx(sampleDocx());
  await assert.rejects(validateDocx(Buffer.from('un archivo falso')), { code: 'DOCX_INVALIDO' });
  await assert.rejects(validateDocx(zipEntries({ 'archivo.txt': 'hola' })), { code: 'DOCX_INVALIDO' });
  await assert.rejects(validateDocx(sampleDocx({ 'word/vbaProject.bin': 'macro' })), { code: 'DOCX_INVALIDO' });
});
test('rechaza recursos externos de Word, incluyendo atributos XML codificados; permite hipervínculos', async () => {
  const relation = type => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" TargetMode="&#69;xternal" Target="http://127.0.0.1/recurso"/></Relationships>`;
  await assert.rejects(validateDocx(sampleDocx({ 'word/_rels/document.xml.rels': relation('image') })), { code: 'DOCX_INVALIDO' });
  await validateDocx(sampleDocx({ 'word/_rels/document.xml.rels': relation('hyperlink') }));
  await assert.rejects(validateDocx(sampleDocx({ 'word/_rels/document.xml.rels': '<!DOCTYPE x><Relationships/>' })), { code: 'DOCX_INVALIDO' });
});
test('el conversor usa argumentos sin shell, directorio aislado y borra temporales', async () => {
  const config = testConfig();
  let directory;
  const result = await createConverter(config, async (binary, args, options) => {
    assert.equal(binary, 'soffice');
    assert.equal(options.windowsHide, true);
    assert.ok(args.includes('--headless'));
    directory = options.cwd;
    assert.ok((await fs.readFile(path.join(directory, 'documento.docx'))).length);
    await fs.writeFile(path.join(directory, 'documento.pdf'), await samplePdf());
  })(sampleDocx());
  assert.equal(result.subarray(0, 5).toString(), '%PDF-');
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});
test('conversión reporta instalación ausente y timeout, sin dejar temporales', async () => {
  const config = testConfig();
  let directory;
  await assert.rejects(createConverter(config, async (_binary, _args, options) => {
    directory = options.cwd;
    throw Object.assign(new Error('no instalado'), { code: 'ENOENT' });
  })(sampleDocx()), { code: 'CONVERSOR_NO_DISPONIBLE' });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  await assert.rejects(createConverter(config, async () => { throw Object.assign(new Error('tiempo'), { killed: true }); })(sampleDocx()), { code: 'CONVERSION_TIMEOUT' });
});
test('si el conversor arranca pero no genera PDF, informa conversión fallida y limpia temporales', async () => {
  let directory;
  await assert.rejects(createConverter(testConfig(), async (_binary, _args, options) => {
    directory = options.cwd;
  })(sampleDocx()), { status: 422, code: 'CONVERSION_FALLIDA' });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('adaptador S3 usa el bucket existente, claves propias y no publica objetos', async () => {
  const config = testConfig();
  const commands = [];
  const bytes = Buffer.from('documento');
  const storage = new S3Storage(config, { async send(command) {
    commands.push(command);
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([bytes]), ContentLength: bytes.length };
    return {};
  } });
  const file = await storage.put('radicados/emitidos/prueba.pdf', bytes, 'application/pdf', 'prueba.pdf');
  assert.equal(file.sha256, sha256(bytes));
  assert.equal(commands[0].input.Bucket, config.bucket);
  assert.equal(commands[0].input.ACL, undefined);
  assert.equal(commands[0].input.ContentType, 'application/pdf');
  assert.deepEqual(await storage.get(file.key), bytes);
  await storage.remove(file.key);
  await assert.rejects(storage.get('commercial-leads/ajeno'), /fuera del prefijo/);
  assert.equal(commands.length, 3);
});

test('si S3 rechaza la conexión, identifica el servicio en carga, lectura y eliminación', async () => {
  const cause = Object.assign(new Error('información interna del proveedor'), { code: 'ECONNREFUSED' });
  const storage = new S3Storage(testConfig(), { async send() { throw cause; } });
  for (const operation of [
    () => storage.put('radicados/prueba.pdf', Buffer.from('prueba'), 'application/pdf', 'prueba.pdf'),
    () => storage.get('radicados/prueba.pdf'),
    () => storage.remove('radicados/prueba.pdf'),
  ]) {
    await assert.rejects(operation(), error => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'ALMACENAMIENTO_NO_DISPONIBLE');
      assert.equal(error.service, 'S3');
      assert.equal(error.cause, cause);
      assert.doesNotMatch(error.message, /información interna/);
      return true;
    });
  }
});

test('S3 reconoce fallos DNS y de conexión agregados sin ocultar errores de permisos', async () => {
  for (const cause of [Object.assign(new Error(), { code: 'ENOTFOUND' }), new AggregateError([Object.assign(new Error(), { code: 'ECONNREFUSED' })])]) {
    const storage = new S3Storage(testConfig(), { async send() { throw cause; } });
    await assert.rejects(storage.get('radicados/prueba.pdf'), { code: 'ALMACENAMIENTO_NO_DISPONIBLE' });
  }
  const denied = Object.assign(new Error('Acceso denegado'), { name: 'AccessDenied' });
  const storage = new S3Storage(testConfig(), { async send() { throw denied; } });
  await assert.rejects(storage.get('radicados/prueba.pdf'), error => error === denied);
});

test('S3 identifica NoSuchBucket por nombre o código sin crear buckets automáticamente', async () => {
  for (const cause of [Object.assign(new Error(), { name: 'NoSuchBucket' }), Object.assign(new Error(), { Code: 'NoSuchBucket' }), Object.assign(new Error(), { code: 'NoSuchBucket' })]) {
    const commands = [];
    const storage = new S3Storage(testConfig(), { async send(command) { commands.push(command.constructor.name); throw cause; } });
    for (const operation of [
      () => storage.put('radicados/prueba.pdf', Buffer.from('prueba'), 'application/pdf', 'prueba.pdf'),
      () => storage.get('radicados/prueba.pdf'),
      () => storage.remove('radicados/prueba.pdf'),
    ]) {
      await assert.rejects(operation(), error => error.status === 503 && error.code === 'ALMACENAMIENTO_SIN_BUCKET' && error.cause === cause);
    }
    assert.deepEqual(commands, ['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']);
  }
});
