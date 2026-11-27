import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';

// Fichiers de l'interface marqués avec la version du panel : après une mise à jour, aucun cache (navigateur,
// Cloudflare) ne peut servir un ancien fichier, puisque chaque version a ses propres adresses.
// - index.html : jamais mis en cache, « __ASTRA_VERSION__ » remplacé par la version ;
// - modules JavaScript : leurs imports relatifs reçoivent « ?v=<version> ».

const IMPORT_RE = /(\b(?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"?#]+\.js)\2/g;

// Adresses des pages de l'interface (sans « # », voir public/js/router.js) : le navigateur reçoit index.html et
// l'interface affiche la bonne page (/home, /apps/<id>/console, /settings/compte…).
export const APP_PATH_RE = /^\/(?:home|new|apps|settings|storage|aide)(?:\/|$)/;

export function versionImports(source, version) {
  return source.replace(IMPORT_RE, (_, before, quote, spec) => `${before}${quote}${spec}?v=${encodeURIComponent(version)}${quote}`);
}

// Sert index.html ou un module de public/js ; retourne false pour les autres fichiers (servis tels quels).
export async function servePanelAsset(req, res, publicDir, pathname, version) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const send = (status, headers, body) => {
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };

  if (pathname === '/' || pathname === '/index.html' || APP_PATH_RE.test(pathname)) {
    const page = (await readFile(path.join(publicDir, 'index.html'), 'utf8')).replaceAll('__ASTRA_VERSION__', version);
    return send(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(page), 'Cache-Control': 'no-store' }, page);
  }

  if (!/^\/js\/[\w/-]+\.js$/.test(pathname)) return false;
  const file = path.join(publicDir, pathname);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return false;
  const etag = `W/"${version}-${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) return send(304, { ETag: etag, 'Cache-Control': 'no-cache' });
  const body = versionImports(await readFile(file, 'utf8'), version);
  return send(
    200,
    { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ETag: etag, 'Cache-Control': 'no-cache' },
    body,
  );
}

// Adresses de tous les fichiers de l'interface (rechargés par le navigateur après une mise à jour).
export async function listPanelAssets(publicDir) {
  const out = ['/'];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name !== 'index.html') out.push(`/${path.relative(publicDir, full).split(path.sep).join('/')}`);
    }
  };
  await walk(publicDir);
  return out;
}
