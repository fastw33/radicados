'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { HttpError } = require('../../utils/httpError');

// Aísla parsing y descompresión del PDF del hilo HTTP. La cola está acotada.
let active = 0;
const queue = [];
function pump() {
  while (active < 3 && queue.length) {
    active++;
    queue.shift()();
  }
}
function processPdf(task, bytes, config, ...args) {
  if (queue.length >= 64) return Promise.reject(new HttpError(503, 'CAPACIDAD_OCUPADA', 'Hay varios PDF procesándose. Intenta nuevamente'));
  return new Promise((resolve, reject) => {
    queue.push(() => {
      let settled = false;
      const worker = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: { task, bytes, config: { MAX_PAGES: config.MAX_PAGES, markSecret: config.markSecret }, args },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      });
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().finally(() => { active--; pump(); });
        if (error) reject(error);
        else resolve(task === 'stampPdf' ? Buffer.from(result) : result);
      };
      const timer = setTimeout(() => finish(new HttpError(422, 'PDF_TIEMPO_AGOTADO', 'El PDF excede el tiempo permitido de procesamiento')), 30000);
      worker.once('message', message => {
        if (message.ok) finish(null, message.result);
        else finish(new HttpError(message.error.status, message.error.code, message.error.message, message.error.details));
      });
      worker.once('error', () => finish(new HttpError(422, 'PDF_LIMITE_RECURSOS', 'No fue posible procesar el PDF dentro de los límites de recursos')));
      worker.once('exit', () => { if (!settled) finish(new HttpError(422, 'PDF_NO_PROCESABLE', 'El procesamiento del PDF terminó sin resultado')); });
    });
    pump();
  });
}
module.exports = Object.fromEntries(['inspectPdf', 'checkPlacement', 'stampPdf', 'recognizePdf'].map(task => [task, (bytes, config, ...args) => processPdf(task, bytes, config, ...args)]));
