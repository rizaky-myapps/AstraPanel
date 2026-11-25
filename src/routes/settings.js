import { HttpError, streamLog } from '../http/util.js';
import { normalizeDomains } from '../caddy.js';
import { systemInfo } from '../system.js';
import { analyze, listMounts } from '../storage.js';

export function settingsRoutes(router, { store, caddy, apps, config, metrics, tunnel, updater, publish }) {
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
  router.post('/api/update/check', () => updater.check(), { admin: true });
  router.post(
    '/api/update/branch',
    async (ctx) => {
      const { branch } = await ctx.json();
      updater.setBranch(branch);
      return updater.check();
    },
    { admin: true },
  );
  router.post('/api/update/apply', (ctx) => updater.request(ctx.user), { admin: true });
  router.get('/api/update/log', async () => ({ log: await updater.log(), run: await updater.runStatus() }), { admin: true });

  // --- Tunnel Cloudflare ------------------------------------------------------
  router.get('/api/tunnel', () => tunnel.status(), { admin: true });
  router.get('/api/tunnel/logs/stream', (ctx) => streamLog(ctx.req, ctx.res, tunnel.log), { admin: true });
  router.post('/api/tunnel/install', async () => ({ version: await tunnel.install() }), { admin: true });
  router.post(
    '/api/tunnel/token',
    async (ctx) => {
      const { token } = await ctx.json();
      await tunnel.setToken(token);
      await caddy.apply();
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
      await caddy.apply(); // Caddy laisse désormais les domaines au tunnel
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
      await caddy.apply();
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
      await caddy.apply();
      return tunnel.status();
    },
    { admin: true },
  );

  // --- Paramètres généraux ------------------------------------------------------

  router.get('/api/settings', async () => ({
    settings: store.data.settings,
    caddy: await caddy.status(),
    panel: { version: config.version, port: config.port, dataDir: config.dataDir, node: process.version },
  }), { admin: true });

  router.patch('/api/settings', async (ctx) => {
    const input = await ctx.json();
    const next = structuredClone(store.data.settings);

    if ('caddyEnabled' in input) {
      next.caddy.enabled = input.caddyEnabled === null ? null : Boolean(input.caddyEnabled);
    }
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

  router.post('/api/settings/caddy/apply', () => caddy.apply(), { admin: true });
}
