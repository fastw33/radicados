'use strict';

const mongoose = require('mongoose');
const { createModels } = require('../modules/radicados');

async function connectDatabase(config) {
  mongoose.set('strictQuery', true);
  mongoose.set('bufferCommands', false);
  // El destino del módulo es independiente de la base que figure en una URI copiada.
  const connection = mongoose.createConnection(config.MONGO_URI, {
    dbName: config.MONGO_DB_NAME || 'radicados', serverSelectionTimeoutMS: 10000, autoIndex: false,
  });
  try {
    await connection.asPromise();
    const models = createModels(connection);
    // Operación aditiva: conserva colecciones e índices existentes.
    await Promise.all(Object.values(models).map(model => model.createIndexes()));
    return { connection, models };
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
}
module.exports = { connectDatabase };
