'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { PDFDocument, PDFName, PDFArray, decodePDFRawStream } = require('pdf-lib');
const { connectDatabase } = require('../src/config/db');
const { RadicadoService } = require('../src/modules/radicados/radicado.service');
const { createApp } = require('../src/app');
const { testConfig, samplePdf, issueBody, MemoryStorage, sampleDocx } = require('./helpers');

let mongo, connection, models, storage, service, app, pdf;
const config = testConfig();
const token = (id, permisos = {}) => jwt.sign({ id_usuario: id, id_personal: `personal-${id}`, username: `usuario-${id}`, permisos }, config.JWT_SECRET, { expiresIn: '1h' });
const adminToken = token('admin', { esAdmin: true });
const authorToken = token('autor', { radicadosEmitir: true, radicadosConsultar: true });
const otherToken = token('otro', { radicadosEmitir: true, radicadosConsultar: true });
const author = { id: 'personal-autor', id_personal: 'personal-autor', id_usuario: 'autor', name: 'usuario-autor', permissions: { radicadosEmitir: true, radicadosConsultar: true }, admin: false };
const company = { id: 'empresa-prueba', nombre: 'Empresa de prueba', prefijo: 'TEST', areas: [{ id: 'administracion', nombre: 'Administración' }], usuariosPermitidos: ['personal-autor', 'personal-lector'], activo: true };
const api = (method, url, accessToken = authorToken) => request(app)[method](url).set('Authorization', `Bearer ${accessToken}`);
async function prepare() {
  const response = await api('post', '/api/v1/preparaciones').attach('documento', pdf, 'carta.pdf');
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}
async function issue(preparation, key = randomUUID(), overrides = {}) {
  return api('post', '/api/v1/radicados').set('Idempotency-Key', key).send(issueBody(preparation.id, overrides));
}
before(async () => {
  mongo = await MongoMemoryServer.create();
  ({ connection, models } = await connectDatabase({ ...config, MONGO_URI: mongo.getUri('base_comercial_no_utilizar') }));
  storage = new MemoryStorage();
  pdf = await samplePdf();
  service = new RadicadoService({ models, storage, config, converter: async () => pdf });
  app = createApp({ service, config, logger: { error() {} } });
  const result = await api('put', '/api/v1/empresas/empresa-prueba', adminToken).send(company);
  assert.equal(result.status, 200, JSON.stringify(result.body));
}, { timeout: 180000 });
after(async () => { await connection?.close(); await mongo?.stop(); });

test('usa la base independiente radicados aunque la URI apunte a otra base', async () => {
  assert.equal(connection.name, 'radicados');
  const commercial = connection.useDb('base_comercial_no_utilizar', { useCache: true });
  assert.equal((await commercial.db.listCollections().toArray()).length, 0);
  const ownCollections = (await connection.db.listCollections().toArray()).map(item => item.name);
  for (const name of ['radicados', 'radicados_contadores', 'radicados_preparaciones', 'radicados_empresas']) assert.ok(ownCollections.includes(name));
});

test('requiere JWT válido y permisos, y permite health sin autenticación', async () => {
  assert.equal((await request(app).get('/health')).status, 200);
  assert.equal((await request(app).get('/api/v1/radicados')).status, 401);
  assert.equal((await api('get', '/api/v1/radicados', token('sin-permisos'))).status, 403);
  assert.equal((await api('get', '/api/v1/radicados', jwt.sign({ id_usuario: '1' }, config.JWT_SECRET))).status, 401);
  const expired = jwt.sign({ id_usuario: '1', permisos: { esAdmin: true } }, config.JWT_SECRET, { expiresIn: -1 });
  assert.equal((await api('get', '/api/v1/radicados', expired)).status, 401);
  const password = jwt.sign({ id_usuario: '1', id_personal: 'P1', permisos: { esAdmin: true }, debe_cambiar_password: true }, config.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await api('get', '/api/v1/radicados', password)).status, 403);
});
test('flujo completo: preparar, previsualizar, emitir, descargar y verificar', async () => {
  const preparation = await prepare();
  assert.equal(preparation.paginas[0].anchoPt, 612);
  assert.equal(preparation.coordenadas.origen, 'superior-izquierdo');
  const preview = await api('get', preparation.vistaPrevia);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['content-type'], 'application/pdf');
  const response = await issue(preparation);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const record = response.body;
  assert.match(record.consecutivo, /^DG-\d{4}-\d{3,}$/);
  assert.equal(record.estado, 'issued');
  assert.equal(record.actor.id_personal, 'personal-autor');
  assert.equal(record.actor.id_usuario, 'autor');
  assert.equal(record.pdf.key, undefined);
  assert.equal(record.idempotencyKey, undefined);
  const download = await api('get', record.descarga);
  assert.equal(download.status, 200);
  const emittedPdf = await PDFDocument.load(download.body, { updateMetadata: false });
  assert.equal(emittedPdf.getTitle(), `${record.consecutivo} | Carta de prueba`);
  assert.equal(emittedPdf.getAuthor(), 'Genika | Empresa de prueba');
  assert.equal(emittedPdf.getCreator(), 'Genika');
  assert.equal(emittedPdf.getProducer(), 'Genika');
  assert.ok(emittedPdf.catalog.has(PDFName.of('Metadata')));
  const verification = await api('post', '/api/v1/verificaciones').attach('documento', download.body, 'emitido.pdf');
  assert.equal(verification.status, 200, JSON.stringify(verification.body));
  assert.equal(verification.body.resultados[0].archivoExacto, true);
  assert.equal(verification.body.resultados[0].marcaReconocida, true);
  assert.equal(verification.body.resultados[0].esMio, true);
  const original = await api('get', `/api/v1/radicados/${record.id}/original`);
  assert.deepEqual(original.body, pdf);
});
test('puede devolver directamente el PDF al emitir, con id y consecutivo en encabezados', async () => {
  const prep = await prepare();
  const response = await api('post', '/api/v1/radicados?respuesta=pdf').set('Idempotency-Key', randomUUID()).send(issueBody(prep.id));
  assert.equal(response.status, 201);
  assert.equal(response.headers['content-type'], 'application/pdf');
  assert.ok(response.headers['x-radicado-id']);
  assert.ok(response.headers['x-radicado-consecutivo']);
});
test('reintentar la misma solicitud no consume otro número; cambios con la misma clave se rechazan', async () => {
  const prep = await prepare(), key = randomUUID();
  const first = await issue(prep, key);
  const repeated = await issue(prep, key);
  assert.equal(first.status, 201);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.id, first.body.id);
  assert.equal(repeated.body.repetido, true);
  assert.equal(await models.Record.countDocuments({ 'actor.id_personal': 'personal-autor', idempotencyKey: key }), 1);
  assert.equal((await issue(prep, key, { referencia: 'otra carta' })).status, 409);
  assert.equal((await issue(prep, randomUUID())).status, 409);
});
test('emisiones simultáneas generan consecutivos distintos y las carreras de idempotencia reservan una sola emisión', async () => {
  const preps = await Promise.all(Array.from({ length: 8 }, () => service.prepare({ buffer: pdf, originalname: 'carta.pdf' }, author)));
  const results = await Promise.all(preps.map(prep => service.issue(issueBody(prep.id), randomUUID(), author)));
  assert.equal(new Set(results.map(result => result.record.consecutivo)).size, 8);
  const prep = await service.prepare({ buffer: pdf, originalname: 'carta.pdf' }, author);
  const key = randomUUID();
  const races = await Promise.allSettled(Array.from({ length: 5 }, () => service.issue(issueBody(prep.id), key, author)));
  assert.ok(races.some(result => result.status === 'fulfilled'));
  for (const result of races.filter(result => result.status === 'rejected')) assert.equal(result.reason.status, 409);
  assert.equal(await models.Record.countDocuments({ idempotencyKey: key }), 1);
});
test('no coloca nada cuando faltan coordenadas o el texto no cabe, antes de reservar consecutivo', async () => {
  const prep = await prepare();
  const count = await models.Record.countDocuments();
  const body = issueBody(prep.id);
  delete body.ubicaciones;
  assert.equal((await api('post', '/api/v1/radicados').set('Idempotency-Key', randomUUID()).send(body)).status, 422);
  const small = await issue(prep, randomUUID(), { ubicaciones: [{ pagina: 1, zona: 'encabezado', x: 0, y: 0, ancho: 0.01, alto: 0.05 }] });
  assert.equal(small.status, 422);
  assert.equal(small.body.error.codigo, 'RADICADO_NO_CABE');
  assert.equal(await models.Record.countDocuments(), count);
});
test('controla acceso a empresas, preparaciones, originales y datos de verificación', async () => {
  const prep = await prepare();
  assert.equal((await api('get', prep.vistaPrevia, otherToken)).status, 404);
  const issued = await issue(prep);
  assert.equal((await api('get', issued.body.descarga, otherToken)).status, 404);
  assert.equal((await api('get', `/api/v1/radicados/${issued.body.id}/original`, otherToken)).status, 404);
  const downloaded = await api('get', issued.body.descarga);
  const verification = await api('post', '/api/v1/verificaciones', otherToken).attach('documento', downloaded.body, 'copia.pdf');
  assert.equal(verification.body.reconocido, false);
  const otherPrep = await api('post', '/api/v1/preparaciones', otherToken).attach('documento', pdf, 'carta.pdf');
  const denied = await api('post', '/api/v1/radicados', otherToken).set('Idempotency-Key', randomUUID()).send(issueBody(otherPrep.body.id));
  assert.equal(denied.status, 403);
  const globalReader = token('lector', { radicadosConsultarTodos: true });
  assert.equal((await api('get', issued.body.descarga, globalReader)).status, 200);
});
test('documento alterado conserva reconocimiento, pero la comparación exacta falla', async () => {
  const emitted = await issue(await prepare());
  const download = await api('get', emitted.body.descarga);
  const edited = await PDFDocument.load(download.body);
  edited.getPage(0).drawText('CONTENIDO MODIFICADO', { x: 50, y: 450 });
  const response = await api('post', '/api/v1/verificaciones').attach('documento', Buffer.from(await edited.save()), 'alterado.pdf');
  assert.equal(response.status, 200);
  assert.equal(response.body.resultados[0].marcaReconocida, true);
  assert.equal(response.body.resultados[0].archivoExacto, false);
});
test('anular conserva archivos e historial y no reutiliza el número', async () => {
  const issued = await issue(await prepare());
  const url = `/api/v1/radicados/${issued.body.id}/anulaciones`;
  assert.equal((await api('post', url).send({ motivo: 'Corrección solicitada' })).status, 403);
  const cancelled = await api('post', url, adminToken).send({ motivo: 'Corrección solicitada' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.estado, 'cancelled');
  assert.equal(cancelled.body.historial.at(-1).motivo, 'Corrección solicitada');
  assert.equal((await api('get', issued.body.descarga)).status, 200);
  assert.equal((await api('post', url, adminToken).send({ motivo: 'Segunda anulación' })).status, 409);
  const next = await issue(await prepare());
  assert.ok(next.body.numero > issued.body.numero);
});
test('un fallo de S3 queda registrado y su número nunca se recicla', async () => {
  const prep = await prepare();
  storage.failOn = '/emitidos/';
  const failed = await issue(prep);
  storage.failOn = '';
  assert.equal(failed.status, 500);
  const record = await models.Record.findOne({ preparacionId: prep.id }).lean();
  assert.equal(record.estado, 'failed');
  assert.ok(record.numero);
  const next = await issue(await prepare());
  assert.ok(next.body.numero > record.numero);
});
test('preparación vencida y objeto almacenado alterado bloquean la emisión', async () => {
  const prep = await prepare();
  await models.Preparation.updateOne({ _id: prep.id }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await issue(prep)).status, 410);
  const another = await prepare();
  const stored = await models.Preparation.findById(another.id).lean();
  storage.objects.set(stored.preview.key, Buffer.from('modificado'));
  assert.equal((await issue(another)).status, 502);
});
test('validación HTTP: formato, archivos múltiples, filtro literal, CORS y datos inválidos', async () => {
  assert.equal((await api('post', '/api/v1/preparaciones').attach('documento', Buffer.from('x'), 'mal.exe')).status, 415);
  assert.equal((await api('post', '/api/v1/preparaciones').attach('documento', pdf, 'a.pdf').attach('documento', pdf, 'b.pdf')).status, 400);
  assert.equal((await api('get', '/api/v1/radicados?limite=1000')).status, 422);
  const search = await api('get', '/api/v1/radicados?buscar=%5B%2E%2A');
  assert.equal(search.status, 200);
  assert.equal(search.body.total, 0);
  assert.equal((await api('get', '/api/v1/radicados').set('Origin', 'https://sitio-ajeno.test')).status, 403);
  const missingKey = await api('post', '/api/v1/radicados').send(issueBody(randomUUID()));
  assert.equal(missingKey.status, 422);
});
test('Word pasa por el conversor y conserva el original separado del PDF', async () => {
  const original = sampleDocx();
  const prep = await api('post', '/api/v1/preparaciones').attach('documento', original, 'carta.docx');
  assert.equal(prep.status, 201);
  const issued = await issue(prep.body);
  assert.equal(issued.status, 201);
  const file = await api('get', `/api/v1/radicados/${issued.body.id}/original`).buffer(true).parse((res, done) => {
    const parts = []; res.on('data', chunk => parts.push(chunk)); res.on('end', () => done(null, Buffer.concat(parts)));
  });
  assert.deepEqual(file.body, original);
});
test('prefijo inmutable y empresas solo administrables con permiso', async () => {
  assert.equal((await api('put', '/api/v1/empresas/empresa-prueba').send(company)).status, 403);
  const changed = await api('put', '/api/v1/empresas/empresa-prueba', adminToken).send({ ...company, prefijo: 'OTRO' });
  assert.equal(changed.status, 409);
});
test('serie DG compartida entre empresas y reinicio anual a medianoche de Colombia', async () => {
  await service.saveCompany({ ...company, id: 'segunda-empresa', prefijo: 'SEG' });
  const at = date => new RadicadoService({ models, storage, config, converter: async () => pdf, clock: () => new Date(date) });
  const emit = async (instance, empresaId = company.id) => {
    const prep = await instance.prepare({ buffer: pdf, originalname: 'carta.pdf' }, author);
    return (await instance.issue(issueBody(prep.id, { empresaId }), randomUUID(), author)).record;
  };
  const first = await emit(at('2036-01-01T05:00:00.000Z'));
  const second = await emit(at('2036-01-01T05:00:01.000Z'), 'segunda-empresa');
  const beforeMidnight = await emit(at('2037-01-01T04:59:59.999Z'));
  const newYear = await emit(at('2037-01-01T05:00:00.000Z'));
  assert.equal(first.consecutivo, 'DG-2036-001');
  assert.equal(second.consecutivo, 'DG-2036-002');
  assert.equal(beforeMidnight.consecutivo, 'DG-2036-003');
  assert.equal(newYear.consecutivo, 'DG-2037-001');
  assert.equal(await models.Counter.countDocuments({ _id: 'DG:2036' }), 1);
});
test('el backend rechaza el cuerpo y acepta coordenadas del encabezado del membrete', async () => {
  const prep = await prepare();
  const bodyPlacement = { pagina: 1, zona: 'encabezado', x: 0.1, y: 0.4, ancho: 0.7, alto: 0.05 };
  const denied = await issue(prep, randomUUID(), { ubicaciones: [bodyPlacement] });
  assert.equal(denied.status, 422);
  assert.equal(denied.body.error.codigo, 'FUERA_DEL_MEMBRETE');
  assert.equal(await models.Record.countDocuments({ preparacionId: prep.id }), 0);
  const emitted = await issue(prep, randomUUID(), { ubicaciones: [{ ...bodyPlacement, y: 0.07 }] });
  assert.equal(emitted.status, 201, JSON.stringify(emitted.body));
  assert.equal(emitted.body.ubicaciones[0].zona, 'encabezado');
});
test('acepta el rectángulo de 105 por 18 puntos seleccionado en la franja superior', async () => {
  const prep = await prepare();
  const response = await issue(prep, randomUUID(), {
    ubicaciones: [{ pagina: 1, zona: 'encabezado', x: 333 / 612, y: 2 / 792, ancho: 105 / 612, alto: 18 / 792, tamanoFuente: 9 }],
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.match(response.body.consecutivo, /^DG-\d{4}-\d{3}$/);
});
test('la propiedad depende del id_personal firmado y no del id_usuario ni de un filtro del navegador', async () => {
  const prep = await prepare();
  const emitted = await issue(prep);
  const differentPerson = jwt.sign({ id_usuario: 'autor', personal: { id_personal: 'personal-otro' }, permisos: { radicadosConsultar: true, radicadosEmitir: true } }, config.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await api('get', emitted.body.descarga, differentPerson)).status, 404);
  assert.equal((await api('get', prep.vistaPrevia, differentPerson)).status, 404);
  const samePerson = jwt.sign({ id_usuario: 'cuenta-nueva', personal: { id_personal: 'personal-autor' }, permisos: { radicadosConsultar: true } }, config.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await api('get', emitted.body.descarga, samePerson)).status, 200);
  const mine = await api('get', '/api/v1/radicados?mios=true', samePerson);
  assert.ok(mine.body.items.length > 0);
  assert.ok(mine.body.items.every(row => row.actor.id_personal === 'personal-autor'));
  const forgedFilter = await api('get', '/api/v1/radicados?mios=true&id_personal=personal-autor', differentPerson);
  assert.equal(forgedFilter.status, 422);
  const missingPersonal = jwt.sign({ id_usuario: 'autor', permisos: { radicadosConsultar: true } }, config.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await api('get', '/api/v1/radicados', missingPersonal)).status, 401);
});
test('Mis documentos se limita a la persona incluso con permiso de administrador', async () => {
  const prep = await api('post', '/api/v1/preparaciones', adminToken).attach('documento', pdf, 'carta.pdf');
  const emitted = await api('post', '/api/v1/radicados', adminToken).set('Idempotency-Key', randomUUID()).send(issueBody(prep.body.id));
  assert.equal(emitted.status, 201);
  const mine = await api('get', '/api/v1/radicados?mios=true', adminToken);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.total, 1);
  assert.ok(mine.body.items.every(row => row.actor.id_personal === 'personal-admin'));
});

test('Fastway, Harvest y Greenway permiten escribir el área y responsable sin configurar catálogos', async () => {
  const catalog = await api('get', '/api/v1/empresas');
  for (const [id, nombre] of [['fastway', 'Fastway'], ['harvest', 'Harvest'], ['greenway', 'Greenway']]) {
    assert.equal(catalog.body.items.find(company => company._id === id)?.nombre, nombre);
    const prep = await prepare();
    const response = await issue(prep, randomUUID(), {
      empresaId: id, areaId: undefined, areaNombre: 'Dirección de Operaciones', responsable: { nombre: 'Responsable escrito por el usuario' },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.empresa.nombre, nombre);
    assert.equal(response.body.area.nombre, 'Dirección de Operaciones');
    assert.equal(response.body.responsable.nombre, 'Responsable escrito por el usuario');
    assert.equal(response.body.actor.id_personal, 'personal-autor');
  }
  assert.equal(await models.Company.countDocuments({ _id: { $in: ['fastway', 'harvest', 'greenway'] } }), 0);
});

test('escribir el área no permite eludir permisos ni emitir para empresas desconocidas', async () => {
  const prep = await prepare();
  const body = { ...issueBody(prep.id), areaNombre: 'Área manual' };
  delete body.areaId;
  for (const empresaId of ['empresa-desconocida', 'empresa-prueba']) {
    const response = await api('post', '/api/v1/radicados', otherToken).set('Idempotency-Key', randomUUID()).send({ ...body, empresaId });
    assert.equal(response.status, 403);
  }
  const withoutArea = { ...body, empresaId: 'fastway' };
  delete withoutArea.areaNombre;
  const emitted = await api('post', '/api/v1/radicados').set('Idempotency-Key', randomUUID()).send(withoutArea);
  assert.equal(emitted.status, 201, JSON.stringify(emitted.body));
  assert.equal(emitted.body.area, undefined);
  assert.equal(emitted.body.actor.id_personal, 'personal-autor');
  const blankArea = await issue(await prepare(), randomUUID(), { empresaId: 'harvest', areaId: '', areaNombre: '  ' });
  assert.equal(blankArea.status, 201, JSON.stringify(blankArea.body));
  assert.equal(blankArea.body.area, undefined);
});

test('la selección en una página se estampa y se registra en todas, incluidas páginas rotadas', async () => {
  const source = await samplePdf([0, 90, 0]);
  const prep = await api('post', '/api/v1/preparaciones').attach('documento', source, 'varias-paginas.pdf');
  assert.equal(prep.status, 201);
  const placement = { pagina: 2, zona: 'encabezado', x: 0.2, y: 0.02, ancho: 0.5, alto: 0.05, tamanoFuente: 9 };
  const response = await issue(prep.body, randomUUID(), { ubicaciones: [placement] });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.deepEqual(response.body.ubicaciones, [1, 2, 3].map(pagina => ({ ...placement, pagina })));
  const download = await api('get', response.body.descarga);
  const document = await PDFDocument.load(download.body);
  const expected = Buffer.from(response.body.consecutivo).toString('hex').toUpperCase();
  for (const page of document.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => document.context.lookup(ref)) : [contents];
    const operators = streams.map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')).join('\n');
    assert.ok(operators.toUpperCase().includes(`<${expected}>`), 'El texto del mismo radicado está dibujado en cada página');
  }
  const verified = await api('post', '/api/v1/verificaciones').attach('documento', download.body, 'varias-paginas.pdf');
  assert.equal(verified.body.resultados[0].paginas.length, 3);
  assert.equal(verified.body.resultados[0].archivoExacto, true);
  assert.equal((await models.Record.findById(response.body.id).lean()).ubicaciones.length, 3);
});

test('comprueba que el radicado cabe en todas las hojas antes de reservar un número', async () => {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  document.addPage([200, 792]);
  const source = Buffer.from(await document.save());
  const prep = await api('post', '/api/v1/preparaciones').attach('documento', source, 'tamanos-distintos.pdf');
  const count = await models.Record.countDocuments();
  const response = await issue(prep.body, randomUUID(), {
    ubicaciones: [{ pagina: 1, zona: 'encabezado', x: 0.2, y: 0.02, ancho: 0.2, alto: 0.05, tamanoFuente: 9 }],
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.codigo, 'RADICADO_NO_CABE');
  assert.equal(response.body.error.detalles.pagina, 2);
  assert.equal(await models.Record.countDocuments(), count);
  const nonexistent = await issue(prep.body, randomUUID(), {
    ubicaciones: [{ pagina: 3, zona: 'encabezado', x: 0.1, y: 0.02, ancho: 0.8, alto: 0.05 }],
  });
  assert.equal(nonexistent.body.error.codigo, 'PAGINA_INEXISTENTE');
});

test('la configuración explícita de una empresa estándar mantiene sus restricciones de acceso', async () => {
  const configured = await api('put', '/api/v1/empresas/fastway', adminToken).send({ ...company, id: 'fastway', nombre: 'Fastway', prefijo: 'FW', activo: false });
  assert.equal(configured.status, 200);
  const prep = await prepare();
  const response = await issue(prep, randomUUID(), { empresaId: 'fastway', areaId: undefined, areaNombre: 'Dirección' });
  assert.equal(response.status, 403);
  const catalog = await api('get', '/api/v1/empresas');
  assert.equal(catalog.body.items.some(company => company._id === 'fastway'), false);
});

test('el destinatario puede omitirse o dejarse vacío sin bloquear la emisión', async () => {
  for (const destinatario of [undefined, '', '   ']) {
    const prep = await prepare();
    const body = issueBody(prep.id);
    if (destinatario === undefined) delete body.destinatario;
    else body.destinatario = destinatario;
    const response = await api('post', '/api/v1/radicados').set('Idempotency-Key', randomUUID()).send(body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.destinatario, '');
  }
});

test('validar distingue un documento propio de uno autorizado de otra persona', async () => {
  const emitted = await issue(await prepare());
  const download = await api('get', emitted.body.descarga);
  const reader = token('lector', { radicadosConsultarTodos: true });
  const checked = await api('post', '/api/v1/verificaciones', reader).attach('documento', download.body, 'copia.pdf');
  assert.equal(checked.status, 200);
  assert.equal(checked.body.resultados[0].esMio, false);
  assert.equal(checked.body.resultados[0].archivoExacto, true);
  assert.equal(checked.body.resultados[0].referencia, emitted.body.referencia);
  assert.equal(checked.body.resultados[0].empresa.id, emitted.body.empresa.id);
  const inaccessible = await api('post', '/api/v1/verificaciones', otherToken).attach('documento', download.body, 'copia.pdf');
  assert.equal(inaccessible.body.reconocido, false);
  assert.deepEqual(inaccessible.body.resultados, []);
});

test('preparar un PDF guarda una sola copia sin repetir la carga de la vista previa', async () => {
  const count = storage.objects.size;
  const prep = await prepare();
  const stored = await models.Preparation.findById(prep.id).lean();
  assert.equal(stored.original.key, stored.preview.key);
  assert.equal(storage.objects.size, count + 1);
  assert.equal((await api('get', prep.vistaPrevia)).status, 200);
});

test('Word guarda original y PDF en paralelo y limpia ambos ante un fallo parcial', async () => {
  const isolated = new MemoryStorage();
  const put = isolated.put.bind(isolated);
  let originalFinished = false;
  isolated.put = async (...args) => {
    if (args[0].endsWith('/vista-previa.pdf')) {
      assert.equal(originalFinished, false, 'La vista previa debe empezar sin esperar al original');
      throw new Error('Fallo de vista previa simulado');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    const result = await put(...args);
    originalFinished = true;
    return result;
  };
  const instance = new RadicadoService({ models, storage: isolated, config, converter: async () => pdf });
  await assert.rejects(instance.prepare({ originalname: 'carta.docx', buffer: sampleDocx() }, author), /Fallo de vista previa simulado/);
  assert.equal(originalFinished, true);
  assert.equal(isolated.objects.size, 0);
});
