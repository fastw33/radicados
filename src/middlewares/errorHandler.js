'use strict';

const multer = require('multer');
const { ZodError } = require('zod');
const { HttpError } = require('../utils/httpError');

function createErrorHandler(logger = console) {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status || 500;
    let code = error.code || 'ERROR_INTERNO';
    let message = error instanceof HttpError || status < 500 ? error.message : 'No se pudo completar la operación';
    let details = error.details;
    if (error instanceof ZodError) {
      status = 422; code = 'DATOS_INVALIDOS'; message = 'Revisa los datos de la solicitud';
      details = error.issues.map(issue => ({ campo: issue.path.join('.'), mensaje: issue.message }));
    } else if (error instanceof multer.MulterError) {
      status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      code = error.code; message = 'Adjunta un solo archivo dentro del límite configurado';
    } else if (error.code === 11000) {
      status = 409; code = 'REGISTRO_DUPLICADO'; message = 'Ya existe un registro con ese identificador o prefijo';
    }
    if (status >= 500) logger.error(JSON.stringify({
      requestId: req.requestId, code, name: error.name,
      ...(error.service === 'S3' ? { servicio: 'S3', operacion: error.operation, causa: error.cause?.code } : {}),
    }));
    res.status(status).json({ error: { codigo: code, mensaje: message, ...(details ? { detalles: details } : {}) }, requestId: req.requestId });
  };
}
module.exports = { createErrorHandler };
