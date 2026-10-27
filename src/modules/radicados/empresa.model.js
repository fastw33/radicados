'use strict';

const { Schema } = require('mongoose');

function createCompanyModel(connection) {
  const schema = new Schema({
    _id: String, nombre: { type: String, required: true },
    prefijo: { type: String, required: true, unique: true },
    franjasMembrete: {
      encabezado: { type: Number, default: 0.15 },
      pie: { type: Number, default: 0.15 },
    },
    areas: [{ _id: false, id: String, nombre: String }],
    usuariosPermitidos: [String], activo: Boolean,
  }, { timestamps: true, versionKey: false });
  return connection.model('RadicadoCompany', schema, 'radicados_empresas');
}
module.exports = { createCompanyModel };
