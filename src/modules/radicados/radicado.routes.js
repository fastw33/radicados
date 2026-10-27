'use strict';

const { Router } = require('express');
const { createRadicadoController } = require('./radicado.controller');
const { companySchema, issueSchema, listSchema, idParamsSchema, idempotencyKeySchema, cancellationSchema } = require('./radicado.validator');
const { requirePermission, requireReadAccess } = require('../../middlewares/permissions.middleware');
const { createCapacityLimiter } = require('../../middlewares/capacity.middleware');
const { createDocumentUpload } = require('../../middlewares/upload.middleware');
const { validate } = require('../../middlewares/validate.middleware');

function createRadicadoRouter({ service, config }) {
  const router = Router();
  const controller = createRadicadoController(service);
  const capacity = createCapacityLimiter();
  const upload = createDocumentUpload(config);
  const emit = requirePermission('radicadosEmitir');
  const admin = requirePermission('radicadosAdministrar');
  const id = validate(idParamsSchema, 'params');

  router.get('/empresas', requireReadAccess, controller.listCompanies);
  router.put('/empresas/:id', admin, validate(companySchema, 'body'), controller.saveCompany);
  router.post('/preparaciones', emit, capacity, upload, controller.prepare);
  router.get('/preparaciones/:id/pdf', emit, id, controller.preview);
  router.post('/verificaciones', requireReadAccess, capacity, upload, controller.verify);
  router.get('/radicados', requireReadAccess, validate(listSchema, 'query'), controller.list);
  router.post('/radicados', emit, capacity,
    validate(idempotencyKeySchema, req => req.headers['idempotency-key'], 'idempotencyKey'),
    validate(issueSchema, 'body'), controller.issue);
  router.get('/radicados/:id', requireReadAccess, id, controller.get);
  router.get('/radicados/:id/pdf', requireReadAccess, id, controller.downloadPdf);
  router.get('/radicados/:id/original', requireReadAccess, id, controller.downloadOriginal);
  router.post('/radicados/:id/anulaciones', admin, validate(cancellationSchema, 'body'), id, controller.cancel);
  return router;
}
module.exports = { createRadicadoRouter };
