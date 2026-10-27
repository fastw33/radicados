'use strict';

const { HttpError } = require('../utils/httpError');

function requirePermission(permission) {
  return (req, res, next) => {
    if (req.actor.admin || req.actor.permissions[permission] === true) return next();
    next(new HttpError(403, 'SIN_PERMISO', `Se requiere el permiso ${permission}`));
  };
}
function requireReadAccess(req, res, next) {
  if (req.actor.admin || ['radicadosConsultar', 'radicadosConsultarTodos', 'radicadosEmitir'].some(permission => req.actor.permissions[permission] === true)) return next();
  next(new HttpError(403, 'SIN_PERMISO', 'No tienes acceso a radicados'));
}
module.exports = { requirePermission, requireReadAccess };
