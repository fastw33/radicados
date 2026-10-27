'use strict';

const { PDFDict, PDFName, PDFRef } = require('pdf-lib');

const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
const xml = value => clean(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

function replaceMetadata(pdf, { id, consecutivo, referencia, empresaNombre, fechaEmision, emitidoEn = new Date() }) {
  // Borrar Info completo evita conservar campos personalizados del proveedor anterior.
  const oldInfo = pdf.context.lookup(pdf.context.trailerInfo.Info);
  if (oldInfo instanceof PDFDict) for (const key of oldInfo.keys()) oldInfo.delete(key);

  // Los lectores pueden preferir XMP sobre Info. Retirar sus referencias y sus
  // objetos anteriores, también en páginas/XObjects, antes de escribir el nuevo XMP.
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFDict ? object : object?.dict;
    if (!(dict instanceof PDFDict)) continue;
    const metadata = dict.get(PDFName.of('Metadata'));
    dict.delete(PDFName.of('Metadata'));
    if (metadata instanceof PDFRef) pdf.context.delete(metadata);
    if (dict.get(PDFName.of('Type')) === PDFName.of('Metadata')) pdf.context.delete(ref);
  }

  const code = clean(consecutivo);
  const company = clean(empresaNombre);
  const reference = clean(referencia);
  const title = reference ? `${code} | ${reference}` : code;
  const author = company ? `Genika | ${company}` : 'Genika';
  const subject = `Correspondencia emitida por Genika${company ? ` | ${company}` : ''} | ${code}`;
  const keywords = ['Genika', code, ...(company ? [company] : [])];
  const issued = new Date(emitidoEn);
  const timestamp = issued.toISOString();

  pdf.setTitle(title);
  pdf.setAuthor(author);
  pdf.setSubject(subject);
  pdf.setKeywords(keywords);
  pdf.setCreator('Genika');
  pdf.setProducer('Genika');
  pdf.setCreationDate(issued);
  pdf.setModificationDate(issued);

  const xmp = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Genika">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:genika="https://radicados.appfastway.com/ns/1.0/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(title)}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${xml(author)}</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xml(subject)}</rdf:li></rdf:Alt></dc:description>
   <dc:subject><rdf:Bag>${keywords.map(keyword => `<rdf:li>${xml(keyword)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>
   <pdf:Keywords>${xml(keywords.join(' '))}</pdf:Keywords>
   <pdf:Producer>Genika</pdf:Producer>
   <xmp:CreatorTool>Genika</xmp:CreatorTool>
   <xmp:CreateDate>${timestamp}</xmp:CreateDate>
   <xmp:ModifyDate>${timestamp}</xmp:ModifyDate>
   <xmp:MetadataDate>${timestamp}</xmp:MetadataDate>
   <genika:Id>${xml(id)}</genika:Id>
   <genika:Consecutivo>${xml(code)}</genika:Consecutivo>
   <genika:Empresa>${xml(company)}</genika:Empresa>
   <genika:FechaEmision>${xml(fechaEmision)}</genika:FechaEmision>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const stream = pdf.context.stream(Buffer.from(xmp, 'utf8'), { Type: PDFName.of('Metadata'), Subtype: PDFName.of('XML') });
  pdf.catalog.set(PDFName.of('Metadata'), pdf.context.register(stream));
}

module.exports = { replaceMetadata };
