import { HttpError, streamLog } from '../http/util.js';
import { normalizeDomains } from '../domains.js';
import { systemInfo } from '../system.js';
import { analyze, listMounts } from '../storage.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function settingsRoutes(router, { store, apps, config, metrics, tunnel, updater, publish, audit, hardware }) {
  // --- Système, historique, stockage ----------------------------------------
  router.get('/api/system', async () => ({
    ...(await systemInfo(config.dataDir)),
    panel: { version: config.version, port: config.port },
  }));

  router.get('/api/system/metrics', (ctx) => {
    const data = metrics.query(ctx.query.get('range') || '1h');
    if (!data) throw new HttpError(400, 'Période inconnue');
    return data;
  });

  router.get('/api/storage', async () => ({ mounts: await listMounts(), dataDir: config.dataDir, appsDir: config.appsDir }), { admin: true });
  router.get(
    '/api/storage/analyze',
    (ctx) => analyze(ctx.query.get('path') || '/', { refresh: ctx.query.get('refresh') === '1' }),
    { admin: true },
  );

  // --- Mises à jour du panel --------------------------------------------------
  router.get('/api/update', () => updater.status(), { admin: true });
  router.get('/api/update/progress', () => updater.progress()); // tous les comptes : écran « mise à jour en cours »
  router.post('/api/update/check', () => updater.check(), { admin: true });
  router.post('/api/update/apply', (ctx) => updater.request(ctx.user), { admin: true });
  router.get('/api/update/log', async () => ({ log: await updater.log(), run: await updater.runStatus() }), { admin: true });

  // --- Tunnel Cloudflare ------------------------------------------------------
  router.get('/api/tunnel', () => tunnel.status(), { admin: true });
  router.get('/api/tunnel/logs/stream', (ctx) => streamLog(ctx.req, ctx.res, tunnel.log), { admin: true });
  router.post('/api/tunnel/install', async () => ({ version: await tunnel.install() }), { admin: true });
  router.post('/api/tunnel/check-update', async () => (await tunnel.checkLatest(), tunnel.status()), { admin: true });
  router.post(
    '/api/tunnel/token',
    async (ctx) => {
      const { token } = await ctx.json();
      await tunnel.setToken(token);
      return tunnel.status();
    },
    { admin: true },
  );
  router.post(
    '/api/tunnel/api/connect',
    async (ctx) => {
      const { apiToken } = await ctx.json();
      return { accounts: await tunnel.connect(apiToken) };
    },
    { admin: true },
  );
  router.get('/api/tunnel/api/accounts', async () => ({ accounts: await tunnel.accounts() }), { admin: true });
  router.get('/api/tunnel/api/zones', async (ctx) => ({ zones: await tunnel.zones(ctx.query.get('accountId') || undefined) }), { admin: true });
  router.post(
    '/api/tunnel/api/setup',
    async (ctx) => {
      const { accountId, name } = await ctx.json();
      const sync = await tunnel.setupApiTunnel(accountId, name);
      return { sync, status: await tunnel.status() };
    },
    { admin: true },
  );
  router.post(
    '/api/tunnel/enabled',
    async (ctx) => {
      const { enabled } = await ctx.json();
      if (enabled) await tunnel.enable();
      else await tunnel.stop();
      return tunnel.status();
    },
    { admin: true },
  );
  router.post('/api/tunnel/restart', async () => (await tunnel.restart(), tunnel.status()), { admin: true });
  router.post('/api/tunnel/sync', () => tunnel.sync(), { admin: true });
  router.post(
    '/api/tunnel/dns/replace',
    async (ctx) => {
      const { hostname } = await ctx.json();
      return tunnel.sync({ replace: [String(hostname || '')] });
    },
    { admin: true },
  );
  router.post(
    '/api/tunnel/reset',
    async () => {
      await tunnel.reset();
      return tunnel.status();
    },
    { admin: true },
  );

  // --- Machine (onglet Hardware) ---------------------------------------------
  router.get('/api/hardware', () => hardware.info(), { admin: true });
  router.post(
    '/api/hardware/reboot',
    async (ctx) => {
      const { confirm } = await ctx.json();
      if (confirm !== true) throw new HttpError(400, 'Confirmation manquante');
      return hardware.requestReboot(ctx.user);
    },
    { admin: true },
  );

  // --- Journal d'activité -------------------------------------------------------
  router.get(
    '/api/audit',
    (ctx) =>
      audit.query({
        userId: ctx.query.get('user') || '',
        appId: ctx.query.get('app') || '',
        category: ctx.query.get('category') || '',
        q: ctx.query.get('q') || '',
        before: Number(ctx.query.get('before')) || 0,
        limit: Math.min(Math.max(Number(ctx.query.get('limit')) || 100, 1), 500),
      }),
    { admin: true },
  );

  // --- Tutoriels (affichés dans la page Aide) -----------------------------------
  const DOCS = { tutoriel: 'TUTORIEL.md', cloudflare: 'CLOUDFLARE.md' };
  router.get('/api/docs/:name', async (ctx) => {
    const file = DOCS[ctx.params.name];
    if (!file) throw new HttpError(404, 'Tutoriel introuvable');
    return { markdown: await readFile(path.join(config.root, 'docs', file), 'utf8') };
  });

  // --- Paramètres généraux ------------------------------------------------------

  router.get('/api/settings', async () => ({
    settings: store.data.settings,
    panel: { version: config.version, port: config.port, dataDir: config.dataDir, node: process.version },
  }), { admin: true });

  router.patch('/api/settings', async (ctx) => {
    const input = await ctx.json();
    const next = structuredClone(store.data.settings);

    if ('panelDomain' in input) {
      const domains = normalizeDomains(input.panelDomain);
      if (domains.length > 1) throw new HttpError(400, 'Un seul domaine pour le panel');
      const domain = domains[0] || '';
      const other = domain && apps.apps.find((a) => a.domains?.includes(domain));
      if (other) throw new HttpError(409, `Le domaine ${domain} est déjà utilisé par « ${other.name} »`);
      next.panelDomain = domain;
    }
    if ('portRange' in input) {
      const start = Number(input.portRange?.start);
      const end = Number(input.portRange?.end);
      const valid = (p) => Number.isInteger(p) && p >= 1024 && p <= 65535;
      if (!valid(start) || !valid(end) || start > end) throw new HttpError(400, 'Plage de ports invalide');
      next.portRange = { start, end };
    }

    store.data.settings = next;
    store.save();
    return { settings: next, ...(await publish()) };
  }, { admin: true });

}
