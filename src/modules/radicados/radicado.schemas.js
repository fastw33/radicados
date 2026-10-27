'use strict';

const { Schema } = require('mongoose');

const actorSchema = new Schema({ id: String, id_personal: String, id_usuario: String, name: String }, { _id: false });
const fileSchema = new Schema({ key: String, nombre: String, mime: String, bytes: Number, sha256: String }, { _id: false });

module.exports = { actorSchema, fileSchema };
