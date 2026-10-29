import { HttpError } from '../http/util.js';
import { normalizeDomains } from '../caddy.js';
import { systemInfo } from '../system.js';

export function settingsRoutes(router, { store, caddy, apps, config }) {
  router.get('/api/system', async () => ({
    ...(await systemInfo(config.dataDir)),
    panel: { version: config.version, port: config.port },
  }));

  router.get('/api/settings', async () => ({
    settings: store.data.settings,
    caddy: await caddy.status(),
    panel: { version: config.version, port: config.port, dataDir: config.dataDir, node: process.version },
  }));

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
    return { settings: next, caddy: await caddy.apply() };
  });

  router.post('/api/settings/caddy/apply', () => caddy.apply());
}
