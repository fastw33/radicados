'use strict';

function sendFile(res, result, inline = false) {
  res.setHeader('Content-Type', result.mime);
  const encoded = encodeURIComponent(result.nombre).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="documento${result.mime === 'application/pdf' ? '.pdf' : '.docx'}"; filename*=UTF-8''${encoded}`);
  return res.send(result.bytes);
}
module.exports = { sendFile };
