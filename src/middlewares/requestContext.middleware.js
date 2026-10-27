'use strict';

const { randomUUID } = require('node:crypto');

function requestContext(req, res, next) {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('Cache-Control', 'no-store');
  next();
}
module.exports = { requestContext };
