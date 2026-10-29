import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
};

export function mimeType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function statFile(file) {
  return stat(file).catch(() => null);
}

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...extra });
  res.end(text);
}

/**
 * Sert un fichier statique depuis `root`.
 * - bloque les chemins contenant un segment caché (.git, .env…) sauf .well-known
 * - `spa` : renvoie index.html pour les routes inconnues
 * - `notFoundPage` : page HTML personnalisée pour les 404 (ex. 404.html)
 */
export async function serveStatic(req, res, root, pathname, options = {}) {
  const { spa = false, notFoundPage = null, cacheControl = 'no-cache' } = options;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Méthode non autorisée', { Allow: 'GET, HEAD' });
  }

  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Requête invalide');
  }
  if (rel.includes('\0')) return sendText(res, 400, 'Requête invalide');

  const normalized = path.posix.normalize('/' + rel.replace(/\\/g, '/'));
  const hidden = normalized.split('/').some((seg) => seg.startsWith('.') && seg !== '.well-known');
  if (hidden) return sendNotFound();

  let file = path.join(root, normalized);
  let info = await statFile(file);

  if (info?.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: pathname + '/' });
      return res.end();
    }
    file = path.join(file, 'index.html');
    info = await statFile(file);
  }

  if (!info?.isFile()) {
    if (spa) {
      file = path.join(root, 'index.html');
      info = await statFile(file);
      if (info?.isFile()) return sendFile(file, info, 200, 'no-cache');
    }
    return sendNotFound();
  }

  return sendFile(file, info, 200, cacheControl);

  async function sendNotFound() {
    if (notFoundPage) {
      const page = path.join(root, notFoundPage);
      const pageInfo = await statFile(page);
      if (pageInfo?.isFile()) return sendFile(page, pageInfo, 404, 'no-cache');
    }
    return sendText(res, 404, 'Introuvable');
  }

  function sendFile(target, fileInfo, status, cache) {
    const etag = `W/"${fileInfo.size.toString(16)}-${Math.floor(fileInfo.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': mimeType(target),
      'Content-Length': fileInfo.size,
      'Last-Modified': fileInfo.mtime.toUTCString(),
      ETag: etag,
      'Cache-Control': cache,
    };
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cache });
      return res.end();
    }
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
