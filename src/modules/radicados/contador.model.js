'use strict';

const { Schema } = require('mongoose');

function createCounterModel(connection) {
  const schema = new Schema({ _id: String, value: { type: Number, default: 0 } }, { versionKey: false });
  return connection.model('RadicadoCounter', schema, 'radicados_contadores');
}
module.exports = { createCounterModel };
