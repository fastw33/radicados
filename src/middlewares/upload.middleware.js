'use strict';

const multer = require('multer');

function createDocumentUpload(config) {
  return multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxBytes, files: 1, fields: 0, parts: 1 } }).single('documento');
}
module.exports = { createDocumentUpload };
