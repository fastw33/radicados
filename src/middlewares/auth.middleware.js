'use strict';

const jwt = require('jsonwebtoken');
const { HttpError } = require('../utils/httpError');

function authenticate(config) {
  return (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      if (!header.startsWith('Bearer ')) throw new Error('missing');
      const payload = jwt.verify(header.slice(7), config.JWT_SECRET, {
        algorithms: ['HS256'],
        ...(config.JWT_ISSUER ? { issuer: config.JWT_ISSUER } : {}),
        ...(config.JWT_AUDIENCE ? { audience: config.JWT_AUDIENCE } : {}),
      });
      const accountId = payload.id_usuario ?? payload.sub;
      const personalId = payload.id_personal ?? payload.personal?.id_personal;
      const validId = id => ['string', 'number'].includes(typeof id) && String(id).trim().length > 0;
      if (!validId(accountId) || !validId(personalId) || !Number.isFinite(payload.exp)) throw new Error('identity');
      let permissions = payload.permisos || {};
      if (typeof permissions === 'string') permissions = JSON.parse(permissions);
      if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw new Error('permissions');
      if (payload.debe_cambiar_password) {
        return next(new HttpError(403, 'CAMBIAR_PASSWORD', 'Debes cambiar tu contraseña antes de emitir documentos'));
      }
      req.actor = {
        id: String(personalId),
        id_personal: String(personalId),
        id_usuario: String(accountId),
        name: [payload.personal?.nombre, payload.personal?.apellido].filter(Boolean).join(' ') || payload.name || payload.username || String(personalId),
        permissions,
        admin: permissions.esAdmin === true || permissions.radicadosAdministrar === true,
      };
      next();
    } catch {
      next(new HttpError(401, 'SESION_INVALIDA', 'Token ausente, inválido o vencido'));
    }
  };
}
module.exports = { authenticate };
