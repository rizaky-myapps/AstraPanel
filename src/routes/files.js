import path from 'node:path';
import { createReadStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { HttpError, receiveToFile } from '../http/util.js';
import { mimeType } from '../http/static.js';
import { sendDownload } from './apps.js';
import {
  compressPaths,
  downloadInfo,
  extractArchive,
  listDir,
  makeDir,
  readTextFile,
  removePath,
  removePaths,
  renamePath,
  transferPaths,
  uploadTarget,
  writeTextFile,
  zipStream,
} from '../apps/files.js';

// Types affichables directement dans le navigateur (aperçu). Tout le reste est téléchargé.
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|svg\+xml|x-icon)|video\/(mp4|webm|ogg)|audio\/(mpeg|ogg|wav)|application\/pdf)/;
const EXTRA_MIME = { '.mov': 'video/mp4', '.m4v': 'video/mp4', '.m4a': 'audio/mpeg', '.flac': 'audio/flac', '.oga': 'audio/ogg', '.ogv': 'video/ogg', '.bmp': 'image/bmp' };

// Envoie un fichier en prenant en charge les requêtes partielles (Range), nécessaires pour avancer dans une vidéo.
function sendRaw(req, res, file, size) {
  const ext = path.extname(file).toLowerCase();
  const type = EXTRA_MIME[ext] || mimeType(file);
  const inline = INLINE_TYPES.test(type) || type.startsWith('audio/') || type.startsWith('video/') || type === 'image/bmp';
  const headers = {
    'Content-Type': inline ? type : 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    'X-Frame-Options': 'SAMEORIGIN',
  };
  // Un fichier des applis ne doit jamais pouvoir exécuter de script dans l'origine du panel (ex. SVG piégé).
  if (type !== 'application/pdf') headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
  else headers['Content-Security-Policy'] = "frame-ancestors 'self'";

  let start = 0;
  let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && size > 0) {
    if (range[1] === '') {
      start = Math.max(0, size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(Number(range[2]), size - 1);
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
  }
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export function fileRoutes(router, { apps, config }) {
  const q = (ctx, key) => ctx.query.get(key) ?? '';
  const appDir = (ctx) => apps.dir(apps.get(ctx.params.id));
  const base = '/api/apps/:id/files';

  router.get(base, (ctx) => listDir(appDir(ctx), q(ctx, 'path')));

  router.get(`${base}/content`, (ctx) => readTextFile(appDir(ctx), q(ctx, 'path'), config.limits.editableFile));
  router.put(`${base}/content`, async (ctx) => {
    const { path: rel, content } = await ctx.json(config.limits.editableFile * 4);
    await writeTextFile(appDir(ctx), rel, content);
  });

  router.post(`${base}/mkdir`, async (ctx) => {
    const { path: rel } = await ctx.json();
    await makeDir(appDir(ctx), rel);
  });
  router.post(`${base}/rename`, async (ctx) => {
    const { from, to } = await ctx.json();
    await renamePath(appDir(ctx), from, to);
  });
  router.post(`${base}/move`, async (ctx) => {
    const { paths, dest } = await ctx.json();
    return { names: await transferPaths(appDir(ctx), paths, dest ?? '', 'move') };
  });
  router.post(`${base}/copy`, async (ctx) => {
    const { paths, dest } = await ctx.json();
    return { names: await transferPaths(appDir(ctx), paths, dest ?? '', 'copy') };
  });
  router.post(`${base}/delete`, async (ctx) => {
    const { paths } = await ctx.json();
    await removePaths(appDir(ctx), paths);
  });
  router.delete(base, (ctx) => removePath(appDir(ctx), q(ctx, 'path')));

  router.post(`${base}/compress`, async (ctx) => {
    const { dir, names, archive } = await ctx.json();
    return { name: await compressPaths(appDir(ctx), dir ?? '', names, archive) };
  });
  router.post(`${base}/extract`, async (ctx) => {
    const { path: rel } = await ctx.json();
    return { name: await extractArchive(appDir(ctx), rel) };
  });

  router.post(`${base}/upload`, async (ctx) => {
    const target = await uploadTarget(appDir(ctx), q(ctx, 'path'), q(ctx, 'name'));
    const part = `${target}.astra-upload`;
    await receiveToFile(ctx.req, part, config.limits.upload);
    await rename(part, target);
  });

  router.get(`${base}/download`, async (ctx) => {
    const { file, size, name } = await downloadInfo(appDir(ctx), q(ctx, 'path'));
    sendDownload(ctx.res, file, size, name);
  });

  router.get(`${base}/raw`, async (ctx) => {
    const { file, size } = await downloadInfo(appDir(ctx), q(ctx, 'path'));
    sendRaw(ctx.req, ctx.res, file, size);
  });

  // Dossier ou sélection multiple, compressé à la volée
  router.get(`${base}/zip`, async (ctx) => {
    const { child, name } = await zipStream(appDir(ctx), q(ctx, 'dir'), ctx.query.getAll('name'));
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (err) =>
        reject(err.code === 'ENOENT' ? new HttpError(500, 'La commande zip est absente : sudo apt install zip') : err),
      );
    });
    ctx.res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    });
    child.stdout.pipe(ctx.res);
    ctx.req.on('close', () => child.kill());
  });

}
