import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { HttpError, readBody, receiveToFile } from '../http/util.js';
import {
  downloadInfo,
  listDir,
  makeDir,
  readTextFile,
  removePath,
  renamePath,
  uploadTarget,
  writeTextFile,
} from '../apps/files.js';

function sendDownload(res, file, size, name, type = 'application/octet-stream') {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

export function appRoutes(router, { apps, config }) {
  const q = (ctx, key) => ctx.query.get(key) ?? '';
  const appDir = (ctx) => apps.dir(apps.get(ctx.params.id));

  // --- Applications -------------------------------------------------------
  router.get('/api/apps', () => apps.list());
  router.post('/api/apps', async (ctx) => apps.create(await ctx.json()));
  router.get('/api/apps/:id', (ctx) => apps.serialize(apps.get(ctx.params.id)));
  router.patch('/api/apps/:id', async (ctx) => apps.update(ctx.params.id, await ctx.json()));
  router.delete('/api/apps/:id', (ctx) => apps.remove(ctx.params.id));

  router.post('/api/apps/:id/start', (ctx) => apps.start(ctx.params.id));
  router.post('/api/apps/:id/stop', (ctx) => apps.stop(ctx.params.id));
  router.post('/api/apps/:id/restart', (ctx) => apps.restart(ctx.params.id));
  router.post('/api/apps/:id/kill', (ctx) => apps.kill(ctx.params.id));

  router.post('/api/apps/:id/tasks/cancel', (ctx) => apps.cancelTask(ctx.params.id));
  router.post('/api/apps/:id/tasks/:task', async (ctx) => {
    const { start } = await ctx.json();
    return apps.runTask(ctx.params.id, ctx.params.task, { start: Boolean(start) });
  });

  router.post('/api/apps/:id/stdin', async (ctx) => {
    const { text } = await ctx.json();
    if (typeof text !== 'string' || text.length > 10000) throw new HttpError(400, 'Commande invalide');
    apps.sendInput(ctx.params.id, text);
  });

  router.post('/api/apps/:id/webhook', (ctx) => ({ webhookToken: apps.regenerateWebhook(ctx.params.id) }));

  router.post('/api/apps/:id/archive', async (ctx) => {
    const app = apps.get(ctx.params.id);
    const filename = path.basename(q(ctx, 'filename') || 'archive.zip');
    const tmp = path.join(config.tmpDir, `upload-${crypto.randomUUID()}`);
    await receiveToFile(ctx.req, tmp, config.limits.upload);
    try {
      await apps.importArchive(app.id, tmp, filename, { clean: q(ctx, 'clean') === '1' });
    } finally {
      await rm(tmp, { force: true });
    }
    if (q(ctx, 'deploy') === '1') apps.runTask(app.id, 'deploy', { start: q(ctx, 'start') === '1' });
    return apps.serialize(app);
  });

  // --- Journaux -----------------------------------------------------------
  router.get('/api/apps/:id/logs/stream', (ctx) => {
    const app = apps.get(ctx.params.id);
    const log = apps.logsFor(app.id);
    const { req, res } = ctx;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: backlog\ndata: ${JSON.stringify(log.lines)}\n\n`);
    const unsubscribe = log.subscribe((line) => {
      res.write(line.clear ? 'event: clear\ndata: {}\n\n' : `data: ${JSON.stringify(line)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      unsubscribe();
      clearInterval(ping);
    });
  });

  router.delete('/api/apps/:id/logs', (ctx) => {
    apps.logsFor(apps.get(ctx.params.id).id).clear();
  });

  router.get('/api/apps/:id/logs/download', (ctx) => {
    const app = apps.get(ctx.params.id);
    const file = path.join(config.logsDir, `${app.id}.log`);
    if (!existsSync(file)) throw new HttpError(404, 'Aucun journal');
    sendDownload(ctx.res, file, statSync(file).size, `${app.id}.log`, 'text/plain; charset=utf-8');
  });

  // --- Fichiers -----------------------------------------------------------
  router.get('/api/apps/:id/files', (ctx) => listDir(appDir(ctx), q(ctx, 'path')));
  router.get('/api/apps/:id/files/content', (ctx) =>
    readTextFile(appDir(ctx), q(ctx, 'path'), config.limits.editableFile),
  );
  router.put('/api/apps/:id/files/content', async (ctx) => {
    const { path: rel, content } = await ctx.json(config.limits.editableFile * 4);
    await writeTextFile(appDir(ctx), rel, content);
  });
  router.post('/api/apps/:id/files/mkdir', async (ctx) => {
    const { path: rel } = await ctx.json();
    await makeDir(appDir(ctx), rel);
  });
  router.post('/api/apps/:id/files/rename', async (ctx) => {
    const { from, to } = await ctx.json();
    await renamePath(appDir(ctx), from, to);
  });
  router.delete('/api/apps/:id/files', (ctx) => removePath(appDir(ctx), q(ctx, 'path')));
  router.post('/api/apps/:id/files/upload', async (ctx) => {
    const target = await uploadTarget(appDir(ctx), q(ctx, 'path'), q(ctx, 'name'));
    const part = `${target}.astra-upload`;
    await receiveToFile(ctx.req, part, config.limits.upload);
    await rename(part, target);
  });
  router.get('/api/apps/:id/files/download', async (ctx) => {
    const { file, size, name } = await downloadInfo(appDir(ctx), q(ctx, 'path'));
    sendDownload(ctx.res, file, size, name);
  });

  // --- Webhook de déploiement (GitHub, GitLab, Gitea…) --------------------
  router.post(
    '/hooks/deploy/:id/:token',
    async (ctx) => {
      const app = apps.checkWebhook(ctx.params.id, ctx.params.token);
      if (!app) throw new HttpError(404, 'Webhook inconnu');
      if (ctx.req.headers['x-github-event'] === 'ping') return { ok: true, message: 'pong' };

      let ref = null;
      const body = (await readBody(ctx.req, 5 * 1024 * 1024)).toString('utf8');
      try {
        const json = body.startsWith('payload=') ? decodeURIComponent(body.slice(8).replace(/\+/g, ' ')) : body;
        ref = JSON.parse(json).ref ?? null;
      } catch {
        // corps vide ou non JSON : on déploie quand même
      }
      if (ref && app.git?.branch && ref !== `refs/heads/${app.git.branch}`) {
        return { ok: true, skipped: `push sur ${ref} ignoré (branche suivie : ${app.git.branch})` };
      }
      apps.logsFor(app.id).system('Déploiement déclenché par webhook');
      apps.runTask(app.id, 'deploy');
      return { ok: true, started: true };
    },
    { auth: false },
  );
}
