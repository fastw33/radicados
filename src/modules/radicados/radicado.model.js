'use strict';

const { Schema } = require('mongoose');
const { actorSchema, fileSchema } = require('./radicado.schemas');

function createRadicadoModel(connection) {
  const schema = new Schema({
    _id: String,
    preparacionId: { type: String, unique: true, required: true },
    idempotencyKey: { type: String, required: true }, requestHash: { type: String, required: true },
    actor: actorSchema, empresa: { id: String, nombre: String, prefijo: String },
    area: { id: String, nombre: String },
    referencia: String, responsable: { id: String, nombre: String },
    destinatario: String, fechaEmision: String,
    ubicaciones: [Schema.Types.Mixed],
    franjasMembrete: { encabezado: Number, pie: Number },
    estado: { type: String, enum: ['processing', 'issued', 'failed', 'cancelled'], required: true },
    numero: Number, anio: Number, consecutivo: String,
    original: fileSchema, pdf: fileSchema,
    error: { code: String, message: String },
    historial: [{ _id: false, evento: String, fecha: Date, actor: actorSchema, motivo: String }],
  }, { timestamps: true, versionKey: false });
  schema.index({ 'actor.id': 1, idempotencyKey: 1 }, { unique: true });
  schema.index({ 'actor.id_personal': 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { 'actor.id_personal': { $type: 'string' } } });
  schema.index({ consecutivo: 1 }, { unique: true, partialFilterExpression: { consecutivo: { $type: 'string' } } });
  schema.index({ 'empresa.id': 1, createdAt: -1 });
  schema.index({ 'actor.id': 1, createdAt: -1 });
  schema.index({ 'actor.id_personal': 1, createdAt: -1 });
  schema.index({ estado: 1, createdAt: -1 });
  schema.index({ 'pdf.sha256': 1 }, { sparse: true });
  return connection.model('Radicado', schema, 'radicados');
}
module.exports = { createRadicadoModel };
