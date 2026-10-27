'use strict';

function validate(schema, source, target = source) {
  return (req, res, next) => {
    try {
      const input = typeof source === 'function' ? source(req) : req[source];
      req.validated ||= {};
      req.validated[target] = schema.parse(input);
      next();
    } catch (error) { next(error); }
  };
}
module.exports = { validate };
