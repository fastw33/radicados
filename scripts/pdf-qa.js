'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PDFDocument, StandardFonts, degrees, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = require('pdf-lib');
const { stampPdf, pageGeometry, recognizePdf } = require('../src/integrations/pdf/document');
const { testConfig } = require('../test/helpers');

async function main() {
  const directory = path.join(__dirname, '../.runtime/pdf-qa');
  await fs.mkdir(directory, { recursive: true });
  const config = testConfig();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ubicaciones = [];
  for (const [i, rotation] of [0, 90, 180, 270].entries()) {
    const page = doc.addPage([652, 832]);
    page.setCropBox(20, 20, 612, 792);
    page.setRotation(degrees(rotation));
    const geometry = pageGeometry(page, i);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...geometry.transform));
    page.drawText('GENIKA / PRUEBA DE UBICACION', { x: 45, y: geometry.altoPt - 65, size: 20, font });
    page.drawText(`Pagina ${i + 1} / Rotacion ${rotation} / CropBox desplazado`, { x: 45, y: geometry.altoPt - 90, size: 11, font });
    page.drawText('Este contenido debe permanecer intacto.', { x: 45, y: geometry.altoPt - 150, size: 12, font });
    page.drawRectangle({ x: 45, y: geometry.altoPt - 340, width: geometry.anchoPt - 90, height: 140, borderWidth: 1, borderColor: rgb(0.7, 0.75, 0.8) });
    const place = { pagina: i + 1, zona: 'pie', x: 0.1, y: 0.93, ancho: 0.7, alto: 0.04, tamanoFuente: 10 };
    ubicaciones.push(place);
    page.drawRectangle({ x: place.x * geometry.anchoPt, y: (1 - place.y - place.alto) * geometry.altoPt,
      width: place.ancho * geometry.anchoPt, height: place.alto * geometry.altoPt, borderWidth: 0.5, borderColor: rgb(0.75, 0.25, 0.25) });
    page.pushOperators(popGraphicsState());
  }
  const source = Buffer.from(await doc.save());
  await fs.writeFile(path.join(directory, 'seleccion.pdf'), source);
  const result = await stampPdf(source, config, { id: randomUUID(), consecutivo: 'DG-2026-123', ubicaciones });
  await fs.writeFile(path.join(directory, 'radicado.pdf'), result);
  const verification = await recognizePdf(result, config);
  if (verification.marcas.length !== 4) throw new Error('No se reconocieron todas las páginas');
  await fs.writeFile(path.join(directory, 'verificacion.json'), JSON.stringify(verification, null, 2));
  console.log('PDF de revisión: .runtime/pdf-qa/radicado.pdf. Cuatro rotaciones, CropBox y marcas verificadas.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
