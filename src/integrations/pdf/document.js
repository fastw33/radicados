'use strict';

const {
  PDFDocument, PDFDict, PDFName, StandardFonts, rgb,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix,
} = require('pdf-lib');
const { HttpError } = require('../../utils/httpError');
const { encodeMark, detectMarks } = require('./mark');
const { replaceMetadata } = require('./metadata');
const { DEFAULT_BANDS } = require('../../modules/radicados/radicado.constants');

async function loadPdf(bytes, config, { forEmission = false } = {}) {
  if (!Buffer.from(bytes).subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw new HttpError(422, 'PDF_INVALIDO', 'El archivo no contiene un PDF válido');
  let pdf;
  try { pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true }); }
  catch { throw new HttpError(422, 'PDF_INVALIDO', 'PDF dañado, cifrado o no compatible'); }
  if (pdf.getPageCount() < 1 || pdf.getPageCount() > config.MAX_PAGES)
    throw new HttpError(422, 'LIMITE_PAGINAS', `Se admiten entre 1 y ${config.MAX_PAGES} páginas`);
  if (forEmission) {
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      const dict = object instanceof PDFDict ? object : object?.dict;
      if (!(dict instanceof PDFDict)) continue;
      if (dict.has(PDFName.of('ByteRange')) || dict.get(PDFName.of('Type'))?.toString() === '/Sig')
        throw new HttpError(422, 'PDF_YA_FIRMADO', 'El PDF ya tiene una firma digital. Radica antes de firmar');
      if (['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'GoToR'].includes(dict.get(PDFName.of('S'))?.toString().slice(1)) ||
          ['JS', 'JavaScript', 'XFA', 'EmbeddedFiles', 'RichMediaContent'].some(key => dict.has(PDFName.of(key))))
        throw new HttpError(422, 'PDF_ACTIVO', 'El PDF contiene acciones, adjuntos o formularios XFA no admitidos');
    }
  }
  return pdf;
}

function pageGeometry(page, index) {
  const crop = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const unit = page.node.get(PDFName.of('UserUnit'))?.asNumber?.() ?? 1;
  if (![0, 90, 180, 270].includes(rotation) || unit !== 1)
    throw new HttpError(422, 'GEOMETRIA_NO_COMPATIBLE', 'Normaliza la rotación y UserUnit del PDF antes de cargarlo');
  const width = rotation % 180 ? crop.height : crop.width;
  const height = rotation % 180 ? crop.width : crop.height;
  if (![width, height, crop.x, crop.y].every(Number.isFinite) || width < 72 || height < 72 || width > 14400 || height > 14400)
    throw new HttpError(422, 'PAGINA_INVALIDA', 'Dimensiones de página fuera de los límites admitidos');
  const transforms = {
    0: [1, 0, 0, 1, crop.x, crop.y],
    90: [0, 1, -1, 0, crop.x + crop.width, crop.y],
    180: [-1, 0, 0, -1, crop.x + crop.width, crop.y + crop.height],
    270: [0, -1, 1, 0, crop.x, crop.y + crop.height],
  };
  return { pagina: index + 1, anchoPt: width, altoPt: height, rotacion: rotation, transform: transforms[rotation] };
}

function geometry(pdf) {
  return pdf.getPages().map((page, i) => {
    const { transform, ...description } = pageGeometry(page, i);
    return description;
  });
}

function validatePlacements(pdf, placements, text, font, bands = DEFAULT_BANDS) {
  for (const place of placements) {
    const page = pdf.getPages()[place.pagina - 1];
    if (!page) throw new HttpError(422, 'PAGINA_INEXISTENTE', `No existe la página ${place.pagina}`);
    const inHeader = place.zona === 'encabezado' && place.y >= 0 && place.y + place.alto <= bands.encabezado + 1e-8;
    const inFooter = place.zona === 'pie' && place.y >= 1 - bands.pie - 1e-8 && place.y + place.alto <= 1 + 1e-8;
    if (!inHeader && !inFooter)
      throw new HttpError(422, 'FUERA_DEL_MEMBRETE', 'El radicado debe quedar completamente dentro del encabezado o pie del membrete', {
        pagina: place.pagina, franjasMembrete: bands,
      });
    const g = pageGeometry(page, place.pagina - 1);
    const availableWidth = place.ancho * g.anchoPt;
    const availableHeight = place.alto * g.altoPt;
    if (font.widthOfTextAtSize(text, place.tamanoFuente) + 4 > availableWidth || place.tamanoFuente + 4 > availableHeight)
      throw new HttpError(422, 'RADICADO_NO_CABE', 'El radicado no cabe en el rectángulo seleccionado. Amplía el espacio o reduce la fuente', {
        pagina: place.pagina, texto: text,
        anchoMinimoPt: Math.ceil(font.widthOfTextAtSize(text, place.tamanoFuente) + 4),
        altoMinimoPt: place.tamanoFuente + 4,
      });
  }
}

async function inspectPdf(bytes, config) {
  const pdf = await loadPdf(bytes, config, { forEmission: true });
  return geometry(pdf);
}

async function checkPlacement(bytes, config, placements, text, bands = DEFAULT_BANDS) {
  const pdf = await loadPdf(bytes, config, { forEmission: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  validatePlacements(pdf, placements, text, font, bands);
}

async function stampPdf(bytes, config, { id, consecutivo, ubicaciones, franjasMembrete = DEFAULT_BANDS, metadata = {} }) {
  const pdf = await loadPdf(bytes, config, { forEmission: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const text = consecutivo;
  validatePlacements(pdf, ubicaciones, text, font, franjasMembrete);
  for (const [index, page] of pdf.getPages().entries()) {
    const g = pageGeometry(page, index);
    const image = await pdf.embedPng(encodeMark(id, index + 1, config.markSecret));
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...g.transform));
    // Dos copias de una marca gráfica por página, cada una con un HMAC propio del radicado.
    // Opacidad 4%, puntos de 0.5pt. No es una firma digital ni resiste todo reescaneo.
    const placements = ubicaciones.filter(p => p.pagina === index + 1);
    for (const position of [{ x: 8, y: 8 }, { x: g.anchoPt - 44, y: g.altoPt - 44 }]) {
      page.drawImage(image, { ...position, width: 36, height: 36, opacity: 0.04 });
    }
    // Los puntos tienen fondo transparente. La selección del radicado no se rellena
    // con blanco ni se desplaza automáticamente.
    for (const place of placements) {
      const x = place.x * g.anchoPt + 2;
      const bottom = (1 - place.y - place.alto) * g.altoPt;
      const y = bottom + (place.alto * g.altoPt - place.tamanoFuente) / 2 + place.tamanoFuente * 0.2;
      page.drawText(text, { x, y, size: place.tamanoFuente, font, color: rgb(0.12, 0.16, 0.2) });
    }
    page.pushOperators(popGraphicsState());
  }
  replaceMetadata(pdf, { ...metadata, id, consecutivo });
  return Buffer.from(await pdf.save());
}

async function recognizePdf(bytes, config) {
  const pdf = await loadPdf(bytes, config);
  try { return { paginas: pdf.getPageCount(), marcas: detectMarks(pdf, config.markSecret) }; }
  catch { throw new HttpError(422, 'PDF_NO_VERIFICABLE', 'El PDF no permite recuperar las marcas dentro de los límites admitidos'); }
}
module.exports = { loadPdf, geometry, pageGeometry, inspectPdf, checkPlacement, stampPdf, recognizePdf };
