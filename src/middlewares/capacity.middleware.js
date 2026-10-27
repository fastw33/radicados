'use strict';

const { HttpError } = require('../utils/httpError');

function createCapacityLimiter(limit = 4) {
  let active = 0;
  return (req, res, next) => {
    if (active >= limit) return next(new HttpError(503, 'CAPACIDAD_OCUPADA', 'Hay varios documentos procesándose. Intenta nuevamente'));
    active++;
    let released = false;
    const release = () => { if (!released) { active--; released = true; } };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}
module.exports = { createCapacityLimiter };
