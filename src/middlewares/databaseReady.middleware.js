'use strict';

const { HttpError } = require('../utils/httpError');

function requireDatabaseReady(ready) {
  return (req, res, next) => {
    if (!ready()) return next(new HttpError(503, 'SERVICIO_NO_DISPONIBLE', 'La base de datos no está disponible'));
    next();
  };
}
module.exports = { requireDatabaseReady };
