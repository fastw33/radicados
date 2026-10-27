'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { createHash } = require('node:crypto');
const { HttpError } = require('../../utils/httpError');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

class S3Storage {
  constructor(config, client) {
    this.config = config;
    this.client = client || new S3Client({
      region: config.region,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: config.S3_FORCE_PATH_STYLE === 'true' } : {}),
    });
  }
  validateKey(key) {
    if (!key.startsWith(`${this.config.prefix}/`) || key.includes('..'))
      throw new Error('Objeto fuera del prefijo de radicados');
  }
  async send(command) {
    try {
      return await this.client.send(command);
    } catch (error) {
      const candidates = [error, error.cause, ...(Array.isArray(error.errors) ? error.errors : [])];
      const network = candidates.find(item => ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(item?.code));
      if (!network) throw error;
      const failure = new HttpError(503, 'ALMACENAMIENTO_NO_DISPONIBLE', 'No se pudo conectar con el almacenamiento de documentos. El administrador debe revisar el servicio S3 configurado');
      failure.cause = network;
      failure.service = 'S3';
      failure.operation = command.constructor.name;
      throw failure;
    }
  }
  async put(key, bytes, mime, nombre) {
    this.validateKey(key);
    await this.send(new PutObjectCommand({
      Bucket: this.config.bucket, Key: key, Body: bytes, ContentType: mime,
      CacheControl: 'private, no-store', ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
      Metadata: { sha256: sha256(bytes), application: 'genika-radicados' },
      // Sin ACL pública. Se conserva la política de cifrado del bucket existente.
    }));
    return { key, nombre, mime, bytes: bytes.length, sha256: sha256(bytes) };
  }
  async get(key) {
    this.validateKey(key);
    const result = await this.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    const limit = this.config.maxBytes * 5;
    if (result.ContentLength > limit) {
      result.Body?.destroy?.();
      throw new HttpError(413, 'ARCHIVO_GRANDE', 'El objeto almacenado supera el límite permitido');
    }
    let size = 0;
    const parts = [];
    for await (const chunk of result.Body) {
      size += chunk.length;
      if (size > limit) {
        result.Body?.destroy?.();
        throw new HttpError(413, 'ARCHIVO_GRANDE', 'El objeto almacenado supera el límite permitido');
      }
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  }
  async remove(key) {
    this.validateKey(key);
    await this.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}
module.exports = { S3Storage, sha256 };
