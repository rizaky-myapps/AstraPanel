import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { HttpError, readBody, receiveToFile, streamLog } from '../http/util.js';

export function sendDownload(res, file, size, name, type = 'application/octet-stream') {
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

  // --- Applications -------------------------------------------------------
  router.get('/api/apps', () => apps.list());
  router.post('/api/apps', async (ctx) => apps.create(await ctx.json()));
  router.get('/api/apps/:id', (ctx) => apps.serialize(apps.get(ctx.params.id)));
  router.patch('/api/apps/:id', async (ctx) => apps.update(ctx.params.id, await ctx.json()));
  router.delete('/api/apps/:id', (ctx) => apps.remove(ctx.params.id), { admin: true });

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
    streamLog(ctx.req, ctx.res, apps.logsFor(apps.get(ctx.params.id).id));
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
