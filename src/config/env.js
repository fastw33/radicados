'use strict';

const { z } = require('zod');

function loadConfig(env = process.env) {
  const parsed = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3010),
    MONGO_URI: z.string().min(1),
    MONGO_DB_NAME: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('radicados'),
    // Se valida con el secreto ya emitido por Genika, sin rotarlo ni sustituirlo.
    JWT_SECRET: z.string().min(1),
    JWT_ISSUER: z.string().optional(),
    JWT_AUDIENCE: z.string().optional(),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    AWS_REGION: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    AWS_S3_BUCKET: z.string().optional(),
    S3_ENDPOINT: z.string().url().optional().or(z.literal('')),
    S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
    S3_PREFIX: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/).default('radicados'),
    MARK_SECRET: z.string().regex(/^[a-fA-F0-9]{64}$/),
    LIBREOFFICE_PATH: z.string().min(1).default('soffice'),
    LIBREOFFICE_PYTHON: z.string().optional(),
    CONVERSION_MODE: z.enum(['persistent', 'process']).default('persistent'),
    CONVERSION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180000).default(60000),
    MAX_FILE_MB: z.coerce.number().int().min(1).max(50).default(20),
    MAX_PAGES: z.coerce.number().int().min(1).max(500).default(100),
    PREVIEW_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(90),
  }).parse(env);
  const bucket = parsed.S3_BUCKET || parsed.AWS_S3_BUCKET;
  const region = parsed.AWS_REGION || parsed.S3_REGION;
  if (!bucket || !region) throw new Error('Configura S3_BUCKET y AWS_REGION');
  return {
    ...parsed, bucket, region,
    prefix: parsed.S3_PREFIX.replace(/\/+$/, ''),
    maxBytes: parsed.MAX_FILE_MB * 1024 * 1024,
    markSecret: Buffer.from(parsed.MARK_SECRET, 'hex'),
    corsOrigins: parsed.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
  };
}
module.exports = { loadConfig };
