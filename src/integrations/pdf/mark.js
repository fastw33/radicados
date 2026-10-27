'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const { PNG } = require('pngjs');
const { inflateSync } = require('node:zlib');
const { PDFName, PDFRawStream, PDFDict, PDFArray } = require('pdf-lib');

// Marca gráfica: 24x24 celdas, micropunto de 1 píxel en cada celda de 3.
// Contiene GNK1 + UUID (16 bytes) + página (2) + HMAC truncado (16).
// El detector lee los píxeles de imágenes realmente invocadas en el PDF.
const CELLS = 24;
const STEP = 3;
const SIZE = CELLS * STEP;
const PAYLOAD_BYTES = 38;
const MAGIC = Buffer.from('GNK1');
const tag = (data, secret) => createHmac('sha256', secret).update('genika-radicados/mark/v1\0').update(data).digest().subarray(0, 16);

function decodeBounded(stream, limit) {
  const filter = stream.dict.get(PDFName.of('Filter'));
  const filters = filter instanceof PDFArray ? filter.asArray().map(value => value.toString()) : filter ? [filter.toString()] : [];
  if (stream.dict.has(PDFName.of('DecodeParms'))) return null;
  if (filters.length === 0) {
    if (stream.contents.length > limit) throw new Error('PDF_CONTENT_LIMIT');
    return Buffer.from(stream.contents);
  }
  if (filters.length !== 1 || filters[0] !== '/FlateDecode') return null;
  return inflateSync(stream.contents, { maxOutputLength: limit });
}

function encodeMark(id, page, secret) {
  const data = Buffer.alloc(22);
  MAGIC.copy(data);
  Buffer.from(id.replaceAll('-', ''), 'hex').copy(data, 4);
  data.writeUInt16BE(page, 20);
  const payload = Buffer.concat([data, tag(data, secret)]);
  const png = new PNG({ width: SIZE, height: SIZE });
  png.data.fill(255);
  for (let pixel = 3; pixel < png.data.length; pixel += 4) png.data[pixel] = 0;
  let bit = 0;
  for (let row = 0; row < CELLS; row++) {
    for (let col = 0; col < CELLS; col++) {
      const border = row === 0 || col === 0 || row === CELLS - 1 || col === CELLS - 1;
      const on = border ? ((row + col) % 2 === 0) : bit < payload.length * 8 && (payload[bit >> 3] & (1 << (7 - bit % 8))) !== 0;
      if (!border) bit++;
      if (on) {
        const offset = ((row * STEP + 1) * SIZE + col * STEP + 1) * 4;
        png.data[offset] = png.data[offset + 1] = png.data[offset + 2] = 0;
        png.data[offset + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

function decodeMark(rgb, secret) {
  if (rgb.length !== SIZE * SIZE * 3) return null;
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  let bit = 0;
  for (let row = 1; row < CELLS - 1; row++) {
    for (let col = 1; col < CELLS - 1; col++) {
      if (bit >= PAYLOAD_BYTES * 8) break;
      const p = ((row * STEP + 1) * SIZE + col * STEP + 1) * 3;
      if (rgb[p] + rgb[p + 1] + rgb[p + 2] < 384) payload[bit >> 3] |= 1 << (7 - bit % 8);
      bit++;
    }
  }
  if (!payload.subarray(0, 4).equals(MAGIC)) return null;
  if (!timingSafeEqual(payload.subarray(22), tag(payload.subarray(0, 22), secret))) return null;
  const hex = payload.subarray(4, 20).toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { id, paginaCodificada: payload.readUInt16BE(20) };
}

function detectMarks(document, secret) {
  const found = [];
  let decodedBytes = 0;
  for (const [index, page] of document.getPages().entries()) {
    const visited = new Set();
    let operations = 0;
    const visit = (streams, resources, depth) => {
      if (depth > 10 || !resources) return;
      const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xobjects) return;
      for (const stream of streams) {
        if (!(stream instanceof PDFRawStream)) continue;
        const decoded = decodeBounded(stream, Math.max(1, 32 * 1024 * 1024 - decodedBytes));
        if (!decoded) continue;
        decodedBytes += decoded.length;
        const content = decoded.toString('latin1');
        for (const match of content.matchAll(/\/([A-Za-z0-9_.#-]+)\s+Do\b/g)) {
          if (++operations > 10000) throw new Error('PDF_CONTENT_LIMIT');
          const ref = xobjects.get(PDFName.of(match[1]));
          if (!ref || visited.has(ref.toString())) continue;
          visited.add(ref.toString());
          const object = document.context.lookup(ref);
          if (!(object instanceof PDFRawStream)) continue;
          const type = object.dict.get(PDFName.of('Subtype'))?.toString();
          if (type === '/Form') {
            visit([object], object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) || resources, depth + 1);
          } else if (type === '/Image' && object.dict.get(PDFName.of('Width'))?.asNumber?.() === SIZE &&
            object.dict.get(PDFName.of('Height'))?.asNumber?.() === SIZE &&
            object.dict.get(PDFName.of('BitsPerComponent'))?.asNumber?.() === 8 &&
            object.dict.get(PDFName.of('ColorSpace'))?.toString() === '/DeviceRGB' &&
            object.dict.get(PDFName.of('Filter'))?.toString() === '/FlateDecode' &&
            !object.dict.has(PDFName.of('DecodeParms'))) {
            const rgb = decodeBounded(object, SIZE * SIZE * 3);
            const mark = rgb && decodeMark(rgb, secret);
            if (mark) found.push({ ...mark, paginaEncontrada: index + 1 });
          }
        }
      }
    };
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => document.context.lookup(ref)) : [contents];
    visit(streams, page.node.Resources(), 0);
  }
  return found;
}
module.exports = { encodeMark, decodeMark, detectMarks, SIZE };
