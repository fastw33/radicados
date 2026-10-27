'use strict';

const { createCompanyModel } = require('./empresa.model');
const { createPreparationModel } = require('./preparacion.model');
const { createCounterModel } = require('./contador.model');
const { createRadicadoModel } = require('./radicado.model');

function createModels(connection) {
  return {
    Company: createCompanyModel(connection),
    Preparation: createPreparationModel(connection),
    Counter: createCounterModel(connection),
    Record: createRadicadoModel(connection),
  };
}
module.exports = { createModels };
