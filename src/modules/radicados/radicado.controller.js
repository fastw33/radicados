'use strict';

const { HttpError } = require('../../utils/httpError');
const { sendFile } = require('../../utils/sendFile');

function createRadicadoController(service) {
  return {
    async listCompanies(req, res) {
      res.json({ items: await service.companies(req.actor) });
    },
    async saveCompany(req, res) {
      const data = req.validated.body;
      if (data.id !== req.params.id) throw new HttpError(422, 'EMPRESA_INCONSISTENTE', 'El id de empresa debe coincidir con la ruta');
      res.json(await service.saveCompany(data));
    },
    async prepare(req, res) {
      const result = await service.prepare(req.file, req.actor);
      res.location(`/api/v1/preparaciones/${result.id}/pdf`).status(201).json(result);
    },
    async preview(req, res) {
      sendFile(res, await service.preview(req.validated.params.id, req.actor), true);
    },
    async verify(req, res) {
      res.json(await service.verify(req.file, req.actor));
    },
    async list(req, res) {
      res.json(await service.list(req.validated.query, req.actor));
    },
    async issue(req, res) {
      const { record, replayed } = await service.issue(req.validated.body, req.validated.idempotencyKey, req.actor);
      res.setHeader('X-Radicado-Id', record.id);
      res.setHeader('X-Radicado-Consecutivo', record.consecutivo);
      res.location(`/api/v1/radicados/${record.id}`);
      if (req.query.respuesta === 'pdf') {
        return sendFile(res.status(replayed ? 200 : 201), await service.download(record.id, req.actor));
      }
      res.status(replayed ? 200 : 201).json({ ...record, repetido: replayed });
    },
    async get(req, res) {
      res.json(await service.get(req.validated.params.id, req.actor));
    },
    async downloadPdf(req, res) {
      sendFile(res, await service.download(req.validated.params.id, req.actor), req.query.vista === 'inline');
    },
    async downloadOriginal(req, res) {
      sendFile(res, await service.download(req.validated.params.id, req.actor, 'original'));
    },
    async cancel(req, res) {
      res.json(await service.cancel(req.validated.params.id, req.validated.body.motivo, req.actor));
    },
  };
}
module.exports = { createRadicadoController };
