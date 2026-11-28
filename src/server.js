#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { AppManager } from './apps/manager.js';
import { Metrics } from './metrics.js';
import { AppMetrics } from './app-metrics.js';
import { Tunnel } from './tunnel.js';
import { PortManager } from './nat/index.js';
import { Updater } from './update.js';
import { AuditLog } from './audit.js';
import { Hardware } from './hardware.js';
import { bootId } from './system.js';
import { REFUSED_ALREADY_RUNNING, acquireInstanceLock, launchedByApp } from './instance.js';
import { Router } from './http/router.js';
import { serveStatic } from './http/static.js';
import { listPanelAssets, servePanelAsset } from './http/panel-assets.js';
import { HttpError, clientIp, readJson, sendJson } from './http/util.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import { appRoutes } from './routes/apps.js';
import { settingsRoutes } from './routes/settings.js';
import { portRoutes } from './routes/ports.js';
import { fileRoutes } from './routes/files.js';

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
  const tunnel = new Tunnel({ store, config: cfg });
  // les domaines des applis sont publiés par le tunnel Cloudflare
  const publish = async () => ({ tunnel: await tunnel.sync() });
  const apps = new AppManager({ store, config: cfg, publish });
  // ports de la box : serveurs de jeux créés, supprimés ou changés de port → redirections mises à jour
  const ports = new PortManager({ store, config: cfg, apps });
  apps.onPortsChange = () => ports.schedule();
  const metrics = new Metrics(path.join(cfg.dataDir, 'metrics.json'));
  const appMetrics = new AppMetrics(path.join(cfg.dataDir, 'app-metrics.json'), apps);
  const updater = new Updater({ store, config: cfg });
  const audit = new AuditLog({ file: path.join(cfg.dataDir, 'audit.log'), store });
  // mise à jour automatique lancée par le panel lui-même : notée dans le journal d'activité
  updater.onAutoUpdate = (version) => audit.record({ category: 'panel', label: 'Mise à jour automatique du panel lancée', detail: `vers la version ${version}` });
  const hardware = new Hardware({ config: cfg });

  const router = new Router();
  const deps = { store, auth, apps, config: cfg, metrics, appMetrics, tunnel, updater, publish, audit, hardware, ports };
  authRoutes(router, deps);
  accountRoutes(router, deps);
  appRoutes(router, deps);
  fileRoutes(router, deps);
  settingsRoutes(router, deps);
  portRoutes(router, deps);

  async function handle(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname.startsWith('/docs/images/')) {
        await serveStatic(req, res, path.join(cfg.root, 'docs', 'images'), pathname.slice('/docs/images'.length));
        return;
      }
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/hooks/')) {
        if (await servePanelAsset(req, res, cfg.publicDir, pathname, cfg.version)) return;
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
        body: null,
        // le corps lu est gardé pour le journal d'activité
        json: async (limit = cfg.limits.jsonBody) => (ctx.body = await readJson(req, limit)),
      };
      if (route.auth) {
        ctx.user = auth.userFromRequest(req);
        if (!ctx.user) throw new HttpError(401, 'Non connecté');
        if (route.admin && ctx.user.role !== 'admin') throw new HttpError(403, 'Action réservée aux administrateurs');
        if (route.app) apps.getFor(ctx.user, params.id); // 404 si l'appli n'est pas accessible à ce compte
      }
      // journal d'activité : chaque action réussie d'un compte connecté
      const pre = ctx.user && MUTATING.has(req.method) ? audit.prepare(ctx, route, apps) : null;
      const extra = pre?.key === 'POST /api/update/apply' ? { version: updater.state.latestVersion } : {};
      const result = await route.handler(ctx);
      if (pre) audit.done(pre, ctx, result, extra);
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

  return { server, store, auth, apps, metrics, appMetrics, tunnel, updater, audit, hardware, ports };
}

async function main() {
  // Garde-fous : jamais lancé par une application du panel, et un seul panel par dossier de données
  const fromApp = launchedByApp();
  if (fromApp) {
    console.error(fromApp);
    process.exit(1);
  }
  const lock = acquireInstanceLock(config.dataDir);
  if (!lock.ok) {
    console.error(
      `✖ ${REFUSED_ALREADY_RUNNING} (${config.dataDir}${lock.pid ? `, processus ${lock.pid}` : ''}) : un second panel ne peut pas démarrer. ` +
        'Le service tourne déjà : sudo systemctl status astrapanel',
    );
    process.exit(1);
  }

  const panel = createPanel();
  const { server, store, auth, apps, metrics, appMetrics, tunnel, updater, ports } = panel;

  // Premier lancement depuis le démarrage de la machine ? (sans identifiant connu, on considère un simple redémarrage)
  const currentBoot = bootId();
  const systemBoot = Boolean(currentBoot && store.data.state.bootId && store.data.state.bootId !== currentBoot);
  if (currentBoot !== store.data.state.bootId) {
    store.data.state.bootId = currentBoot;
    store.save();
  }

  // Le tunnel Cloudflare démarre tout de suite, en même temps que le serveur web du panel.
  tunnel.bootstrap();

  server.listen(config.port, config.host, async () => {
    console.log(`AstraPanel ${config.version} — http://${config.host === '0.0.0.0' ? '<ip-de-la-machine>' : config.host}:${config.port}`);
    console.log(`Données : ${config.dataDir}`);
    const token = auth.ensureSetupToken();
    if (token) {
      console.log('──────────────────────────────────────────────');
      console.log(` Première connexion : jeton d'installation = ${token}`);
      console.log(` (aussi disponible dans ${config.dataDir}/setup-token)`);
      console.log('──────────────────────────────────────────────');
    }
    metrics.start();
    appMetrics.start();
    updater.start();
    apps.bootstrap({ systemBoot });
    // ports de la box : détection de l'opérateur au premier lancement, puis redirections tenues à jour
    ports.bootstrap();
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
    metrics.stop();
    appMetrics.stop();
    updater.stop();
    ports.shutdown();
    await Promise.all([apps.shutdown(), tunnel.shutdown()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
