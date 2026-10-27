'use strict';

const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');
const { randomBytes } = require('node:crypto');
const { issueSchema } = require('../src/modules/radicados/radicado.validator');

function testConfig() {
  return {
    NODE_ENV: 'test', JWT_SECRET: 'prueba-exclusiva-no-es-un-secreto-real-123456789',
    JWT_ISSUER: '', JWT_AUDIENCE: '',
    corsOrigins: ['http://localhost:5173'], maxBytes: 2 * 1024 * 1024,
    MAX_PAGES: 100, PREVIEW_HOURS: 24, prefix: 'radicados', RATE_LIMIT_PER_MINUTE: 1000,
    bucket: 'bucket-de-prueba', region: 'us-east-1', S3_FORCE_PATH_STYLE: 'false',
    markSecret: randomBytes(32), LIBREOFFICE_PATH: 'soffice', CONVERSION_TIMEOUT_MS: 2000,
  };
}
async function samplePdf(rotations = [0]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const rotation of rotations) {
    const page = doc.addPage([612, 792]);
    page.setRotation(degrees(rotation));
    page.drawText('GENIKA - DOCUMENTO DE PRUEBA', { x: 45, y: 740, size: 18, font });
    page.drawText('Contenido que debe conservarse sin cubrir.', { x: 45, y: 690, size: 12, font });
    page.drawRectangle({ x: 45, y: 500, width: 400, height: 120, borderColor: rgb(0.2, 0.3, 0.4), borderWidth: 1 });
  }
  return Buffer.from(await doc.save());
}
function issueBody(preparacionId, overrides = {}) {
  return issueSchema.parse({
    preparacionId, empresaId: 'empresa-prueba', areaId: 'administracion',
    referencia: 'Carta de prueba', responsable: { nombre: 'Responsable de prueba' },
    destinatario: 'Destinatario de prueba', fechaEmision: '2026-10-26',
    ubicaciones: [{ pagina: 1, zona: 'pie', x: 0.08, y: 0.92, ancho: 0.75, alto: 0.05 }],
    ...overrides,
  });
}
class MemoryStorage {
  constructor() { this.objects = new Map(); this.failOn = ''; }
  async put(key, bytes, mime, nombre) {
    if (this.failOn && key.includes(this.failOn)) throw new Error('Simulación de S3 no disponible');
    this.objects.set(key, Buffer.from(bytes));
    return { key, bytes: bytes.length, mime, nombre, sha256: require('../src/integrations/s3/s3.storage').sha256(bytes) };
  }
  async get(key) {
    const value = this.objects.get(key);
    if (!value) throw new Error('Objeto no encontrado');
    return Buffer.from(value);
  }
  async remove(key) { this.objects.delete(key); }
}

// ZIP sin compresión para probar el validador y el conversor DOCX con archivos reales.
function zipEntries(entries) {
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const local = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const filename = Buffer.from(name), bytes = Buffer.from(content), checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function sampleDocx(extra = {}) {
  return zipEntries({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Documento Word de prueba Genika</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>',
    ...extra,
  });
}
module.exports = { testConfig, samplePdf, issueBody, MemoryStorage, sampleDocx, zipEntries };
