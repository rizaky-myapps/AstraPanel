import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.ASTRA_DATA_DIR || path.join(ROOT, 'data'));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export const config = {
  version: pkg.version,
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  templatesDir: path.join(ROOT, 'templates'),
  staticServer: path.join(ROOT, 'runtime', 'static-server.js'),

  dataDir: DATA_DIR,
  appsDir: path.join(DATA_DIR, 'apps'),
  logsDir: path.join(DATA_DIR, 'logs'),
  tmpDir: path.join(DATA_DIR, 'tmp'),
  dbFile: path.join(DATA_DIR, 'db.json'),

  host: process.env.ASTRA_HOST || '0.0.0.0',
  port: Number(process.env.ASTRA_PORT || 8080),

  // Dossier où le panel écrit sa configuration Caddy (importée par /etc/caddy/Caddyfile)
  caddyDir: process.env.ASTRA_CADDY_DIR || '/etc/caddy/astrapanel',
  caddyMainConfig: process.env.ASTRA_CADDY_CONFIG || '/etc/caddy/Caddyfile',

  limits: {
    jsonBody: 2 * 1024 * 1024,
    upload: 1024 * 1024 * 1024,
    editableFile: 2 * 1024 * 1024,
    logLines: 1000,
    logFileBytes: 5 * 1024 * 1024,
  },
};
