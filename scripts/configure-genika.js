'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const leadsPath = path.resolve(option('--leads', path.join(root, '../Sistemas Genika/Sistema de Leads/backend/.env')));
const identityPath = path.resolve(option('--identity', path.join(root, '../Sistemas Genika/wmsBack/.env')));
const target = path.join(root, '.env');
if (fs.existsSync(target)) throw new Error('Ya existe .env; se conserva sin cambios');
const leads = dotenv.parse(fs.readFileSync(leadsPath));
const identity = dotenv.parse(fs.readFileSync(identityPath));
const values = {
  NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3010',
  MONGO_URI: (leads.MONGO_URI || '').replace(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/, '$1/radicados$2'),
  MONGO_DB_NAME: 'radicados', JWT_SECRET: identity.JWT_SECRET || '',
  CORS_ORIGINS: 'http://localhost:5173',
  AWS_REGION: leads.AWS_REGION || leads.S3_REGION || '',
  AWS_ACCESS_KEY_ID: leads.AWS_ACCESS_KEY_ID || '',
  AWS_SECRET_ACCESS_KEY: leads.AWS_SECRET_ACCESS_KEY || '',
  AWS_SESSION_TOKEN: leads.AWS_SESSION_TOKEN || '',
  S3_BUCKET: 'radicados',
  S3_ENDPOINT: leads.S3_ENDPOINT || '',
  S3_FORCE_PATH_STYLE: leads.S3_FORCE_PATH_STYLE || 'false',
  S3_PREFIX: 'radicados', MARK_SECRET: randomBytes(32).toString('hex'),
  LIBREOFFICE_PATH: process.platform === 'win32' ? 'C:/Program Files/LibreOffice/program/soffice.com' : 'soffice',
  CONVERSION_TIMEOUT_MS: '60000', MAX_FILE_MB: '20', MAX_PAGES: '100', PREVIEW_HOURS: '24',
};
if (!values.MONGO_URI || !values.JWT_SECRET || !values.S3_BUCKET || !values.AWS_REGION)
  throw new Error('Faltan MONGO_URI, JWT_SECRET, S3_BUCKET o AWS_REGION en los archivos de origen');
// No se muestra ningún secreto. Las comillas preservan #, espacios y caracteres especiales.
const encode = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
fs.writeFileSync(target, Object.entries(values).map(([key, value]) => `${key}=${encode(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log('.env creado: servidor S3 existente, bucket radicados, base radicados y JWT de Genika. No se contactó ningún servicio.');
