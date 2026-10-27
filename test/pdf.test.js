'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { PDFDocument, PDFDict, PDFName, PDFString, degrees } = require('pdf-lib');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { stampPdf, recognizePdf, inspectPdf, checkPlacement, pageGeometry } = require('../src/integrations/pdf/document');
const { testConfig, samplePdf, issueBody } = require('./helpers');
const { issueSchema } = require('../src/modules/radicados/radicado.validator');
const config = testConfig();

test('reemplaza Info y XMP heredados por Genika sin conservar metadatos de proveedores anteriores', async () => {
  const source = await PDFDocument.load(await samplePdf(), { updateMetadata: false });
  source.setTitle('GREEN HARVEST');
  source.setAuthor('Autor anterior');
  source.setSubject('Asunto anterior');
  source.setCreator('Canva');
  source.setProducer('iLovePDF');
  source.setKeywords(['identificador-proveedor-anterior']);
  source.setCreationDate(new Date('2020-01-01T00:00:00Z'));
  source.setModificationDate(new Date('2020-01-02T00:00:00Z'));
  const info = source.context.lookup(source.context.trailerInfo.Info);
  info.set(PDFName.of('TrackingAnterior'), PDFString.of('identificador-proveedor-anterior'));
  for (const dict of [source.catalog, source.getPage(0).node]) {
    const stream = source.context.stream(Buffer.from('<anterior>Canva iLovePDF identificador-proveedor-anterior</anterior>'), {
      Type: PDFName.of('Metadata'), Subtype: PDFName.of('XML'),
    });
    dict.set(PDFName.of('Metadata'), source.context.register(stream));
  }
  const input = Buffer.from(await source.save());
  const id = randomUUID();
  const metadata = { referencia: 'Carta & "prueba" <Nueva> - Ñandú', empresaNombre: 'Harvest & Cía', fechaEmision: '2026-10-20', emitidoEn: new Date('2026-10-27T16:30:00Z') };
  const output = await stampPdf(input, config, { id, consecutivo: 'DG-2026-008', ubicaciones: issueBody(randomUUID()).ubicaciones, metadata });
  const emitted = await PDFDocument.load(output, { updateMetadata: false });
  assert.equal(emitted.getTitle(), `DG-2026-008 | ${metadata.referencia}`);
  assert.equal(emitted.getAuthor(), 'Genika | Harvest & Cía');
  assert.equal(emitted.getSubject(), 'Correspondencia emitida por Genika | Harvest & Cía | DG-2026-008');
  assert.equal(emitted.getCreator(), 'Genika');
  assert.equal(emitted.getProducer(), 'Genika');
  assert.equal(emitted.getKeywords(), 'Genika DG-2026-008 Harvest & Cía');
  assert.equal(emitted.getCreationDate().toISOString(), metadata.emitidoEn.toISOString());
  assert.equal(emitted.getModificationDate().toISOString(), metadata.emitidoEn.toISOString());
  assert.equal(emitted.context.lookup(emitted.context.trailerInfo.Info).has(PDFName.of('TrackingAnterior')), false);
  assert.equal(emitted.getPage(0).node.has(PDFName.of('Metadata')), false);
  const metadataObjects = emitted.context.enumerateIndirectObjects().filter(([, object]) => {
    const dict = object instanceof PDFDict ? object : object?.dict;
    return dict?.get(PDFName.of('Type')) === PDFName.of('Metadata');
  });
  assert.equal(metadataObjects.length, 1, 'Solo queda el nuevo XMP; los objetos anteriores no se serializan');
  const xmp = Buffer.from(emitted.context.lookup(emitted.catalog.get(PDFName.of('Metadata'))).getContents()).toString('utf8');
  assert.equal(XMLValidator.validate(xmp), true);
  const description = new XMLParser().parse(xmp)['x:xmpmeta']['rdf:RDF']['rdf:Description'];
  assert.equal(description['dc:title']['rdf:Alt']['rdf:li'], emitted.getTitle());
  assert.equal(description['dc:creator']['rdf:Seq']['rdf:li'], emitted.getAuthor());
  assert.equal(description['pdf:Producer'], 'Genika');
  assert.equal(description['xmp:CreatorTool'], 'Genika');
  assert.equal(description['xmp:CreateDate'], metadata.emitidoEn.toISOString());
  assert.equal(description['genika:Consecutivo'], 'DG-2026-008');
  assert.equal(description['genika:Empresa'], metadata.empresaNombre);
  assert.equal(description['genika:FechaEmision'], metadata.fechaEmision);
  assert.doesNotMatch(xmp, /Canva|iLovePDF|identificador-proveedor-anterior/);
  assert.equal(output.includes(Buffer.from('identificador-proveedor-anterior')), false);
  const original = await PDFDocument.load(input, { updateMetadata: false });
  assert.equal(original.getCreator(), 'Canva');
  assert.equal(original.getProducer(), 'iLovePDF');
  assert.equal((await recognizePdf(output, config)).marcas[0].id, id);
});

test('marca gráfica autenticada reconocible en cada página, sin depender de metadatos', async () => {
  const id = randomUUID();
  const input = await samplePdf([0, 90, 180, 270]);
  const output = await stampPdf(input, config, { id, consecutivo: 'DG-2026-001', ubicaciones: issueBody(randomUUID()).ubicaciones });
  const found = await recognizePdf(output, config);
  assert.equal(found.paginas, 4);
  assert.equal(found.marcas.length, 4);
  assert.ok(found.marcas.every(m => m.id === id && m.paginaEncontrada === m.paginaCodificada));
  const reopened = await PDFDocument.load(output);
  reopened.setTitle('Documento guardado por otro editor');
  reopened.catalog.delete(PDFName.of('Metadata'));
  const saved = await reopened.save();
  assert.equal((await recognizePdf(saved, config)).marcas.length, 4);
});
test('una clave distinta no acepta la marca y un PDF común no se reconoce', async () => {
  const input = await samplePdf();
  const output = await stampPdf(input, config, { id: randomUUID(), consecutivo: 'DG-2026-001', ubicaciones: issueBody(randomUUID()).ubicaciones });
  assert.equal((await recognizePdf(output, { ...config, markSecret: randomBytes(32) })).marcas.length, 0);
  assert.equal((await recognizePdf(input, config)).marcas.length, 0);
});
test('la marca puede recuperarse dentro de una página incrustada en otro PDF', async () => {
  const id = randomUUID();
  const marked = await stampPdf(await samplePdf(), config, { id, consecutivo: 'DG-2026-001', ubicaciones: issueBody(randomUUID()).ubicaciones });
  const wrapper = await PDFDocument.create();
  const [embedded] = await wrapper.embedPdf(marked);
  wrapper.addPage([612, 792]).drawPage(embedded);
  assert.equal((await recognizePdf(await wrapper.save(), config)).marcas[0].id, id);
});
test('las coordenadas usan CropBox visible y rotaciones ortogonales', async () => {
  const input = await samplePdf([0, 90, 180, 270]);
  const pages = await inspectPdf(input, config);
  assert.deepEqual(pages.map(p => [p.anchoPt, p.altoPt]), [[612, 792], [792, 612], [612, 792], [792, 612]]);
  const pdf = await PDFDocument.load(input);
  for (const [index, page] of pdf.getPages().entries()) {
    page.setCropBox(20, 30, 500, 600);
    const g = pageGeometry(page, index);
    assert.equal(g.anchoPt, index % 2 ? 600 : 500);
    const [a, b, c, d, e, f] = g.transform;
    for (const [x, y] of [[0, 0], [g.anchoPt, g.altoPt]]) {
      const X = a * x + c * y + e, Y = b * x + d * y + f;
      assert.ok(X >= 20 && X <= 520 && Y >= 30 && Y <= 630);
    }
  }
});
test('rechaza coordenadas ausentes, fuera de página y páginas repetidas', () => {
  const base = issueBody(randomUUID());
  for (const ubicaciones of [[], [{ ...base.ubicaciones[0], x: 0.99 }], [base.ubicaciones[0], base.ubicaciones[0]]])
    assert.equal(issueSchema.safeParse({ ...base, ubicaciones }).success, false);
});
test('rechaza una fecha inexistente y contenido adicional no contratado', () => {
  const base = issueBody(randomUUID());
  assert.equal(issueSchema.safeParse({ ...base, fechaEmision: '2026-02-30' }).success, false);
  assert.equal(issueSchema.safeParse({ ...base, consecutivo: 'elegido-por-cliente' }).success, false);
});
test('rechaza texto que no cabe y página inexistente', async () => {
  const input = await samplePdf();
  const placement = issueBody(randomUUID()).ubicaciones[0];
  await assert.rejects(checkPlacement(input, config, [{ ...placement, ancho: 0.01 }], 'DG-2026-001'), { code: 'RADICADO_NO_CABE' });
  await assert.rejects(checkPlacement(input, config, [{ ...placement, pagina: 2 }], 'DG-2026-001'), { code: 'PAGINA_INEXISTENTE' });
});
test('rechaza un PDF ya firmado y acciones JavaScript antes de modificarlo', async () => {
  const pdf = await PDFDocument.load(await samplePdf());
  pdf.context.register(pdf.context.obj({ Type: 'Sig', ByteRange: [0, 1, 2, 3] }));
  await assert.rejects(inspectPdf(await pdf.save(), config), { code: 'PDF_YA_FIRMADO' });
  const active = await PDFDocument.load(await samplePdf());
  active.addJavaScript('script', 'app.alert("hola")');
  await assert.rejects(inspectPdf(await active.save(), config), { code: 'PDF_ACTIVO' });
});
test('no acepta PDF falsos, páginas enormes o unidades especiales', async () => {
  await assert.rejects(inspectPdf(Buffer.from('texto.pdf'), config), { code: 'PDF_INVALIDO' });
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]).node.set(PDFName.of('UserUnit'), pdf.context.obj(2));
  await assert.rejects(inspectPdf(await pdf.save(), config), { code: 'GEOMETRIA_NO_COMPATIBLE' });
});
test('solo permite el encabezado o pie; una franja mayor debe autorizarse en configuración', async () => {
  const input = await samplePdf();
  const place = { pagina: 1, zona: 'encabezado', x: 0.1, y: 0.2, ancho: 0.7, alto: 0.04, tamanoFuente: 10 };
  await assert.rejects(checkPlacement(input, config, [place], 'DG-2026-001'), { code: 'FUERA_DEL_MEMBRETE' });
  await checkPlacement(input, config, [place], 'DG-2026-001', { encabezado: 0.25, pie: 0.15 });
  await assert.rejects(checkPlacement(input, config, [{ ...place, zona: 'pie', y: 0.4 }], 'DG-2026-001'), { code: 'FUERA_DEL_MEMBRETE' });
  const base = issueBody(randomUUID());
  const { zona, ...missingZone } = base.ubicaciones[0];
  assert.equal(issueSchema.safeParse({ ...base, ubicaciones: [missingZone] }).success, false);
});
