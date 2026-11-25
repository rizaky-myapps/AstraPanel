import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, chmod, constants, mkdir, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { HttpError } from './http/util.js';
import { LogBuffer } from './apps/logs.js';
import { baseEnv, killGroup, pipeOutput } from './apps/process.js';

const execFileAsync = promisify(execFile);
const API = process.env.ASTRA_CLOUDFLARE_API || 'https://api.cloudflare.com/client/v4';
const DOWNLOAD = process.env.ASTRA_CLOUDFLARED_URL || 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const BINARIES = { arm64: 'cloudflared-linux-arm64', x64: 'cloudflared-linux-amd64', arm: 'cloudflared-linux-arm' };
const DNS_COMMENT = 'Géré par AstraPanel';

// Accepte le jeton seul ou la commande copiée depuis Cloudflare (« cloudflared service install eyJ… »).
export function parseTunnelToken(input) {
  const match = /eyJ[A-Za-z0-9+/_=-]{20,}/.exec(String(input || ''));
  if (!match) throw new HttpError(400, 'Jeton introuvable : collez le jeton du tunnel ou la commande fournie par Cloudflare');
  let data;
  try {
    data = JSON.parse(Buffer.from(match[0], 'base64').toString('utf8'));
  } catch {
    throw new HttpError(400, 'Jeton de tunnel invalide');
  }
  if (!data?.a || !data?.t || !data?.s) throw new HttpError(400, 'Jeton de tunnel invalide');
  return { token: match[0], accountId: data.a, tunnelId: data.t };
}

// Nom d'hôte publié à partir d'un domaine d'app (« http://site.fr:8080 » -> « site.fr »).
export function hostnameOf(domain) {
  return String(domain).replace(/^https?:\/\//, '').replace(/:\d+$/, '');
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

const mask = (secret) => (secret ? `••••${secret.slice(-4)}` : '');

export class Tunnel {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
    this.localBinary = path.join(config.dataDir, 'bin', 'cloudflared');
    this.log = new LogBuffer(path.join(config.logsDir, '_cloudflared.log'), {
      maxLines: config.limits.logLines,
      maxFileBytes: config.limits.logFileBytes,
    });
    this.child = null;
    this.stopping = false;
    this.crashCount = 0;
    this.restartTimer = null;
    this.metricsPort = null;
    this.startedAt = null;
    this.installing = false;
    this.lastSync = null;
    this.queue = Promise.resolve();
  }

  get settings() {
    return this.store.data.settings.tunnel;
  }

  save(patch) {
    Object.assign(this.store.data.settings.tunnel, patch);
    this.store.save();
  }

  // ---- Binaire cloudflared --------------------------------------------------
  async binary() {
    try {
      await access(this.localBinary, constants.X_OK);
      return this.localBinary;
    } catch {
      // pas de copie locale : cloudflared installé sur le système ?
    }
    try {
      await execFileAsync('cloudflared', ['--version'], { timeout: 10000 });
      return 'cloudflared';
    } catch {
      return null;
    }
  }

  async version(bin) {
    if (!bin) return null;
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 10000 });
      return /version (\S+)/.exec(stdout)?.[1] || stdout.trim();
    } catch {
      return null;
    }
  }

  // Télécharge le binaire officiel depuis GitHub dans le dossier du panel (pas besoin de root).
  async install() {
    if (this.installing) throw new HttpError(409, 'Installation déjà en cours');
    const asset = BINARIES[os.arch()];
    if (os.platform() !== 'linux' || !asset) throw new HttpError(400, `Architecture non prise en charge : ${os.platform()} ${os.arch()}`);
    this.installing = true;
    const tmp = `${this.localBinary}.download`;
    try {
      await mkdir(path.dirname(this.localBinary), { recursive: true });
      this.log.system(`Téléchargement de ${asset}…`);
      const res = await fetch(`${DOWNLOAD}/${asset}`, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`téléchargement refusé (HTTP ${res.status})`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      await chmod(tmp, 0o755);
      const version = await this.version(tmp);
      if (!version) throw new Error('le fichier téléchargé ne s’exécute pas');
      const wasRunning = Boolean(this.child);
      if (wasRunning) await this.stop({ persist: false });
      await rename(tmp, this.localBinary);
      this.log.system(`✔ cloudflared ${version} installé`);
      if (wasRunning) await this.start();
      return version;
    } catch (err) {
      await rm(tmp, { force: true });
      this.log.system(`✖ Installation de cloudflared impossible : ${err.message}`);
      throw new HttpError(502, `Installation de cloudflared impossible : ${err.message}`);
    } finally {
      this.installing = false;
    }
  }

  // ---- Processus cloudflared ------------------------------------------------
  token() {
    return this.settings.mode === 'api' ? this.settings.api.tunnelToken : this.settings.token;
  }

  async start() {
    if (this.child) return;
    const bin = await this.binary();
    if (!bin) throw new HttpError(400, 'cloudflared n’est pas installé');
    const token = this.token();
    if (!token) throw new HttpError(400, 'Aucun tunnel configuré');
    let port = 20241;
    while (port < 20300 && !(await isPortFree(port))) port++;
    this.metricsPort = port;
    clearTimeout(this.restartTimer);
    this.stopping = false;
    this.log.system('▶ Démarrage du tunnel Cloudflare');
    // le jeton passe par l'environnement pour ne pas apparaître dans la liste des processus
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${port}`, 'run'], {
      env: { ...baseEnv(), TUNNEL_TOKEN: token },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.startedAt = Date.now();
    pipeOutput(child, this.log);
    let done = false;
    const onExit = (code, signal) => {
      if (done) return;
      done = true;
      this.handleExit(child, code, signal);
    };
    child.on('exit', onExit);
    child.on('error', (err) => {
      this.log.system(`✖ ${err.message}`);
      onExit(null, null);
    });
  }

  handleExit(child, code, signal) {
    if (this.child !== child) return;
    killGroup(child.pid, 'SIGKILL');
    this.child = null;
    const waiters = this.exitWaiters || [];
    this.exitWaiters = [];
    waiters.forEach((fn) => fn());
    if (this.stopping) {
      this.log.system('■ Tunnel arrêté');
      return;
    }
    this.log.system(`✖ cloudflared s’est arrêté (${signal ? `signal ${signal}` : `code ${code}`})`);
    if (Date.now() - this.startedAt > 120_000) this.crashCount = 0;
    this.crashCount += 1;
    if (!this.settings.enabled) return;
    const delay = Math.min(60_000, 2000 * 2 ** (this.crashCount - 1));
    this.log.system(`↻ Nouvel essai dans ${delay / 1000} s`);
    this.restartTimer = setTimeout(() => this.start().catch((err) => this.log.system(`✖ ${err.message}`)), delay);
  }

  stop({ persist = true } = {}) {
    if (persist) this.save({ enabled: false });
    clearTimeout(this.restartTimer);
    const { child } = this;
    if (!child) return Promise.resolve();
    this.stopping = true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 10_000);
      this.exitWaiters = [...(this.exitWaiters || []), () => (clearTimeout(timer), resolve())];
      if (!killGroup(child.pid, 'SIGTERM')) child.kill('SIGTERM');
    });
  }

  async enable() {
    this.save({ enabled: true });
    this.crashCount = 0;
    await this.start();
    if (this.settings.mode === 'api') this.sync().catch(() => {});
  }

  async restart() {
    if (this.child) await this.stop({ persist: false });
    if (this.settings.enabled) await this.start();
  }

  // État de la connexion, lu sur le serveur de métriques local de cloudflared.
  async ready() {
    if (!this.child || !this.metricsPort) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${this.metricsPort}/ready`, { signal: AbortSignal.timeout(2000) });
      return await res.json();
    } catch {
      return { status: 0, readyConnections: 0 };
    }
  }

  // ---- Configuration -------------------------------------------------------
  async setToken(input) {
    const parsed = parseTunnelToken(input);
    this.save({ mode: 'token', token: parsed.token });
    this.log.system(`Tunnel ${parsed.tunnelId} configuré (géré depuis Cloudflare)`);
    await this.enable();
    return parsed;
  }

  async reset() {
    await this.stop();
    this.save({ enabled: false, mode: 'token', token: '', api: { apiToken: '', accountId: '', accountName: '', tunnelId: '', tunnelName: '', tunnelToken: '' } });
    this.lastSync = null;
    this.log.system('Configuration du tunnel supprimée');
  }

  // ---- API Cloudflare (mode « géré par le panel ») --------------------------
  async api(method, pathname, body, apiToken = this.settings.api.apiToken) {
    if (!apiToken) throw new HttpError(400, 'Aucun jeton d’API Cloudflare enregistré');
    let res;
    try {
      res = await fetch(`${API}${pathname}`, {
        method,
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new HttpError(502, `Cloudflare injoignable : ${err.message}`);
    }
    const data = await res.json().catch(() => null);
    if (!data?.success) {
      const detail = data?.errors?.map((e) => e.message).join(', ') || `HTTP ${res.status}`;
      throw new HttpError(res.status === 403 || res.status === 401 ? 400 : 502, `Cloudflare : ${detail}`);
    }
    return data.result;
  }

  async connect(apiToken) {
    if (typeof apiToken !== 'string' || apiToken.trim().length < 20) throw new HttpError(400, 'Jeton d’API invalide');
    const accounts = await this.api('GET', '/accounts?per_page=50', undefined, apiToken.trim());
    if (!accounts?.length) throw new HttpError(400, 'Ce jeton n’a accès à aucun compte Cloudflare');
    this.save({ api: { ...this.settings.api, apiToken: apiToken.trim() } });
    return accounts.map((a) => ({ id: a.id, name: a.name }));
  }

  async accounts() {
    const accounts = await this.api('GET', '/accounts?per_page=50');
    return accounts.map((a) => ({ id: a.id, name: a.name }));
  }

  async zones(accountId = this.settings.api.accountId) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const list = await this.api('GET', `/zones?per_page=50&page=${page}${accountId ? `&account.id=${encodeURIComponent(accountId)}` : ''}`);
      out.push(...list.map((z) => ({ id: z.id, name: z.name, status: z.status })));
      if (list.length < 50) break;
    }
    return out;
  }

  // Crée le tunnel (ou réutilise celui qui porte ce nom) puis récupère son jeton.
  async setupApiTunnel(accountId, name) {
    if (!/^[a-f0-9]{32}$/.test(String(accountId))) throw new HttpError(400, 'Compte Cloudflare invalide');
    const tunnelName = String(name || '').trim() || `astrapanel-${os.hostname()}`;
    if (!/^[\w.-]{1,64}$/.test(tunnelName)) throw new HttpError(400, 'Nom de tunnel invalide (lettres, chiffres, . _ -)');
    const accounts = await this.accounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new HttpError(400, 'Compte inaccessible avec ce jeton');

    const base = `/accounts/${accountId}/cfd_tunnel`;
    const existing = await this.api('GET', `${base}?name=${encodeURIComponent(tunnelName)}&is_deleted=false`);
    let tunnel = existing?.find((t) => t.name === tunnelName);
    if (tunnel) {
      this.log.system(`Tunnel « ${tunnelName} » existant réutilisé`);
    } else {
      tunnel = await this.api('POST', base, {
        name: tunnelName,
        config_src: 'cloudflare',
        tunnel_secret: crypto.randomBytes(32).toString('base64'),
      });
      this.log.system(`Tunnel « ${tunnelName} » créé sur Cloudflare`);
    }
    const tunnelToken = await this.api('GET', `${base}/${tunnel.id}/token`);
    if (typeof tunnelToken !== 'string' || !tunnelToken) throw new HttpError(502, 'Cloudflare n’a pas renvoyé le jeton du tunnel');

    if (this.child) await this.stop({ persist: false });
    this.save({
      mode: 'api',
      api: { ...this.settings.api, accountId, accountName: account.name, tunnelId: tunnel.id, tunnelName, tunnelToken },
      enabled: true,
    });
    this.crashCount = 0;
    await this.start();
    return this.sync();
  }

  // Domaines à publier : ceux des applications (et du panel), vers leur port local.
  desiredRoutes() {
    const { apps, settings } = this.store.data;
    const routes = [];
    const seen = new Set();
    const add = (domain, port, label) => {
      const hostname = hostnameOf(domain);
      if (seen.has(hostname)) return;
      seen.add(hostname);
      routes.push({ hostname, service: `http://localhost:${port}`, label });
    };
    if (settings.panelDomain) add(settings.panelDomain, this.config.port, 'Panel AstraPanel');
    for (const app of apps) if (app.port) for (const d of app.domains || []) add(d, app.port, app.name);
    return routes;
  }

  // Met à jour les règles du tunnel et les enregistrements DNS (appels sérialisés).
  sync({ replace = [] } = {}) {
    const run = () => this.doSync(replace);
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async doSync(replace) {
    const { enabled, mode, api } = this.settings;
    if (!enabled || mode !== 'api' || !api.tunnelId) return { ok: true, skipped: true };
    const routes = this.desiredRoutes();
    const target = `${api.tunnelId}.cfargotunnel.com`;
    try {
      await this.api('PUT', `/accounts/${api.accountId}/cfd_tunnel/${api.tunnelId}/configurations`, {
        config: {
          ingress: [...routes.map((r) => ({ hostname: r.hostname, service: r.service })), { service: 'http_status:404' }],
        },
      });
      const zones = await this.zones(api.accountId);
      const zoneOf = (hostname) =>
        zones
          .filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`))
          .sort((a, b) => b.name.length - a.name.length)[0];

      for (const route of routes) {
        const zone = zoneOf(route.hostname.replace(/^\*\./, ''));
        if (!zone) {
          Object.assign(route, { status: 'no-zone', message: 'Domaine absent de ce compte Cloudflare' });
          continue;
        }
        route.zone = zone.name;
        try {
          const records = await this.api('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(route.hostname)}&per_page=50`);
          const mine = records.find((r) => r.type === 'CNAME' && r.content === target);
          const others = records.filter((r) => r !== mine && ['A', 'AAAA', 'CNAME'].includes(r.type));
          if (others.length && (replace.includes(route.hostname) || others.every((r) => r.comment === DNS_COMMENT))) {
            for (const r of others) await this.api('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
          } else if (others.length) {
            const desc = others.map((r) => `${r.type} ${r.content}`).join(', ');
            Object.assign(route, { status: 'conflict', message: `Un enregistrement DNS existe déjà (${desc})` });
            continue;
          }
          if (!mine) {
            await this.api('POST', `/zones/${zone.id}/dns_records`, {
              type: 'CNAME',
              name: route.hostname,
              content: target,
              proxied: true,
              ttl: 1,
              comment: DNS_COMMENT,
            });
          }
          Object.assign(route, { status: 'ok', message: mine ? 'En ligne' : 'Enregistrement DNS créé' });
        } catch (err) {
          Object.assign(route, { status: 'error', message: err.message });
        }
      }

      // Supprime les enregistrements créés par le panel pour des domaines qui ne sont plus utilisés.
      const wanted = new Set(routes.map((r) => r.hostname));
      for (const zone of zones) {
        const records = await this.api('GET', `/zones/${zone.id}/dns_records?type=CNAME&content=${encodeURIComponent(target)}&per_page=100`);
        for (const r of records) {
          if (r.comment === DNS_COMMENT && !wanted.has(r.name)) {
            await this.api('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
            this.log.system(`Enregistrement DNS ${r.name} supprimé (domaine retiré)`);
          }
        }
      }

      const problems = routes.filter((r) => r.status !== 'ok');
      this.lastSync = { at: Date.now(), routes, error: null };
      this.log.system(`Synchronisation Cloudflare : ${routes.length - problems.length}/${routes.length} domaine(s) publiés`);
      return problems.length
        ? { ok: false, routes, error: problems.map((r) => `${r.hostname} : ${r.message}`).join(' ; ') }
        : { ok: true, routes };
    } catch (err) {
      this.lastSync = { at: Date.now(), routes, error: err.message };
      this.log.system(`✖ Synchronisation Cloudflare : ${err.message}`);
      return { ok: false, routes, error: err.message };
    }
  }

  async status() {
    const bin = await this.binary();
    const s = this.settings;
    const tokenInfo = s.mode === 'token' && s.token ? (() => {
      try {
        return parseTunnelToken(s.token);
      } catch {
        return null;
      }
    })() : null;
    return {
      binary: bin,
      version: await this.version(bin),
      installing: this.installing,
      running: Boolean(this.child),
      ready: await this.ready(),
      enabled: s.enabled,
      mode: s.mode,
      token: tokenInfo ? { accountId: tokenInfo.accountId, tunnelId: tokenInfo.tunnelId } : null,
      api: {
        connected: Boolean(s.api.apiToken),
        apiToken: mask(s.api.apiToken),
        accountId: s.api.accountId,
        accountName: s.api.accountName,
        tunnelId: s.api.tunnelId,
        tunnelName: s.api.tunnelName,
      },
      routes: this.desiredRoutes(),
      lastSync: this.lastSync,
    };
  }

  async bootstrap() {
    if (!this.settings.enabled || !this.token()) return;
    try {
      await this.start();
      if (this.settings.mode === 'api') await this.sync();
    } catch (err) {
      this.log.system(`✖ ${err.message}`);
    }
  }

  async shutdown() {
    clearTimeout(this.restartTimer);
    await this.stop({ persist: false });
    this.log.close();
  }
}
