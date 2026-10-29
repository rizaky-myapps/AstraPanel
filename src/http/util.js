import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Requête trop volumineuse');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit) {
  const type = req.headers['content-type'] || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Content-Type application/json attendu');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON invalide');
  }
}

// Écrit le corps brut de la requête dans un fichier (téléversements sans multipart).
export async function receiveToFile(req, dest, limit) {
  let size = 0;
  const guard = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > limit) cb(new HttpError(413, 'Fichier trop volumineux'));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, guard, createWriteStream(dest));
  } catch (err) {
    await unlink(dest).catch(() => {});
    throw err;
  }
  return size;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function isLoopback(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// Les en-têtes X-Forwarded-* ne sont pris en compte que s'ils viennent d'un proxy local (Caddy, cloudflared).
export function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const fwd = req.headers['x-forwarded-for'];
  if (fwd && isLoopback(remote)) {
    const parts = String(fwd).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return remote.replace(/^::ffff:/, '');
}

export function isHttps(req) {
  if (req.socket.encrypted) return true;
  return isLoopback(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https';
}
