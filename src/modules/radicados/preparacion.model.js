'use strict';

const { Schema } = require('mongoose');
const { actorSchema, fileSchema } = require('./radicado.schemas');

function createPreparationModel(connection) {
  const schema = new Schema({
    _id: String, actor: actorSchema, original: fileSchema, preview: fileSchema, paginas: [Schema.Types.Mixed],
    expiresAt: { type: Date, index: true },
  }, { timestamps: true, versionKey: false });
  return connection.model('RadicadoPreparation', schema, 'radicados_preparaciones');
}
module.exports = { createPreparationModel };
