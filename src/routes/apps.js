import os from 'node:os';
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

export function appRoutes(router, { apps, appMetrics, config }) {
  const q = (ctx, key) => ctx.query.get(key) ?? '';

  // --- Applications -------------------------------------------------------
  // L'accès aux routes /api/apps/:id… est vérifié une fois pour toutes dans server.js (apps.getFor).
  router.get('/api/apps', (ctx) => apps.list(ctx.user));
  router.post('/api/apps', async (ctx) => apps.create(await ctx.json(), ctx.user));
  router.get('/api/apps/:id', (ctx) => apps.serialize(apps.get(ctx.params.id)));
  router.patch('/api/apps/:id', async (ctx) => apps.update(ctx.params.id, await ctx.json()));
  router.delete(
    '/api/apps/:id',
    async (ctx) => {
      const result = await apps.remove(ctx.params.id);
      appMetrics?.forget(ctx.params.id);
      return result;
    },
    { admin: true },
  );

  // Historique processeur / mémoire de l'application (onglet Statistiques)
  router.get('/api/apps/:id/metrics', (ctx) => {
    const app = apps.get(ctx.params.id);
    const data = appMetrics.query(app.id, ctx.query.get('range') || '1h');
    if (!data) throw new HttpError(400, 'Période inconnue (1h, 24h, 15j ou 30j)');
    const rt = apps.rt(app.id);
    return {
      ...data,
      memTotal: Math.round(os.totalmem() / 1024 / 1024),
      cpus: os.cpus().length,
      runtime: { status: rt.status, startedAt: rt.child ? rt.startedAt : null, restarts: rt.crashCount, cpu: rt.cpu, memory: rt.memory },
    };
  });

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

  // --- Utilisateurs de l'application -----------------------------------------
  router.get('/api/apps/:id/members', (ctx) => apps.members(ctx.user, ctx.params.id));
  router.post('/api/apps/:id/members', async (ctx) => {
    const { userId } = await ctx.json();
    return apps.addMember(ctx.user, ctx.params.id, String(userId || ''));
  });
  router.delete('/api/apps/:id/members/:userId', (ctx) => apps.removeMember(ctx.user, ctx.params.id, ctx.params.userId));

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
      if (!app) {
        apps.noteRejectedWebhook(ctx.params.id);
        throw new HttpError(404, 'Webhook inconnu : adresse incorrecte. Recopiez l’adresse affichée dans l’onglet Déploiement de l’application (elle change quand on la régénère).');
      }
      // Gitea et Forgejo envoient aussi X-GitHub-Event : on les reconnaît d'abord
      const h = ctx.req.headers;
      const [provider, event] =
        [
          ['Forgejo', h['x-forgejo-event']],
          ['Gitea', h['x-gitea-event']],
          ['Gogs', h['x-gogs-event']],
          ['GitLab', h['x-gitlab-event']],
          ['GitHub', h['x-github-event']],
          ['Bitbucket', h['x-event-key']],
        ].find(([, value]) => value) || [null, null];

      let payload = null;
      const body = (await readBody(ctx.req, 5 * 1024 * 1024)).toString('utf8');
      try {
        const json = body.startsWith('payload=') ? decodeURIComponent(body.slice(8).replace(/\+/g, ' ')) : body;
        payload = JSON.parse(json);
      } catch {
        // corps vide ou non JSON : on déploie quand même
      }
      return apps.handleWebhook(app.id, { provider, event, payload });
    },
    { auth: false },
  );
}
