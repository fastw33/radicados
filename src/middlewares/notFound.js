'use strict';

const { HttpError } = require('../utils/httpError');

function notFound(req, res, next) {
  next(new HttpError(404, 'RUTA_NO_ENCONTRADA', 'Ruta no encontrada'));
}
module.exports = { notFound };
