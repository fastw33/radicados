'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { inspectPdf, checkPlacement, stampPdf, recognizePdf } = require('./document');
const tasks = { inspectPdf, checkPlacement, stampPdf, recognizePdf };
(async () => {
  try {
    const { task, bytes, config, args } = workerData;
    config.markSecret = Buffer.from(config.markSecret);
    const result = await tasks[task](Buffer.from(bytes), config, ...args);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: { status: error.status || 422, code: error.code || 'PDF_NO_PROCESABLE', message: error.status ? error.message : 'No fue posible procesar el PDF', details: error.details } });
  }
})();
