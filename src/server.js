#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { Caddy } from './caddy.js';
import { AppManager } from './apps/manager.js';
import { Router } from './http/router.js';
import { serveStatic } from './http/static.js';
import { HttpError, clientIp, readJson, sendJson } from './http/util.js';
import { authRoutes } from './routes/auth.js';
import { appRoutes } from './routes/apps.js';
import { settingsRoutes } from './routes/settings.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

export function createPanel(cfg = config) {
  for (const dir of [cfg.dataDir, cfg.appsDir, cfg.logsDir, cfg.tmpDir]) mkdirSync(dir, { recursive: true, mode: 0o750 });

  const store = new Store(cfg.dbFile);
  const auth = new Auth(store, cfg.dataDir);
  auth.ensureSetupToken();
  const caddy = new Caddy({ store, dir: cfg.caddyDir, mainConfig: cfg.caddyMainConfig, panelPort: cfg.port });
  const apps = new AppManager({ store, caddy, config: cfg });

  const router = new Router();
  const deps = { store, auth, caddy, apps, config: cfg };
  authRoutes(router, deps);
  appRoutes(router, deps);
  settingsRoutes(router, deps);

  async function handle(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/hooks/')) {
        await serveStatic(req, res, cfg.publicDir, pathname, { cacheControl: 'no-cache' });
        return;
      }
      const match = router.match(req.method, pathname);
      if (!match) throw new HttpError(404, 'Route introuvable');
      const { route, params } = match;

      // Protection CSRF : les navigateurs ne peuvent pas ajouter cet en-tête depuis un autre site.
      if (pathname.startsWith('/api/') && MUTATING.has(req.method) && req.headers['x-astra'] !== '1') {
        throw new HttpError(403, 'En-tête X-Astra manquant');
      }
      const ctx = {
        req,
        res,
        url,
        params,
        query: url.searchParams,
        ip: clientIp(req),
        user: null,
        json: (limit = cfg.limits.jsonBody) => readJson(req, limit),
      };
      if (route.auth) {
        ctx.user = auth.userFromRequest(req);
        if (!ctx.user) throw new HttpError(401, 'Non connecté');
      }
      const result = await route.handler(ctx);
      if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (!(err instanceof HttpError)) {
        if (err.code === 'ENOENT') err = new HttpError(404, 'Fichier ou dossier introuvable');
        else if (err.code === 'EACCES' || err.code === 'EPERM') err = new HttpError(403, 'Permission refusée');
        else console.error(err);
      }
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || 'Erreur interne' });
      else res.end();
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.requestTimeout = 60 * 60 * 1000; // gros téléversements sur une connexion lente
  server.headersTimeout = 60 * 1000;

  return { server, store, auth, caddy, apps };
}

async function main() {
  const panel = createPanel();
  const { server, auth, caddy, apps } = panel;

  server.listen(config.port, config.host, async () => {
    console.log(`AstraPanel ${config.version} — http://${config.host === '0.0.0.0' ? '<ip-du-pi>' : config.host}:${config.port}`);
    console.log(`Données : ${config.dataDir}`);
    const token = auth.ensureSetupToken();
    if (token) {
      console.log('──────────────────────────────────────────────');
      console.log(` Première connexion : jeton d'installation = ${token}`);
      console.log(` (aussi disponible dans ${config.dataDir}/setup-token)`);
      console.log('──────────────────────────────────────────────');
    }
    const result = await caddy.apply();
    if (!result.ok) console.warn(`Caddy : ${result.error}`);
    apps.bootstrap();
  });
  server.on('error', (err) => {
    console.error(`Impossible de démarrer le serveur : ${err.message}`);
    process.exit(1);
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} reçu : arrêt des applications…`);
    server.close();
    await apps.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
