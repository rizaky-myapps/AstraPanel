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
import { compareVersions } from './version.js';

const execFileAsync = promisify(execFile);
const apiBase = () => process.env.ASTRA_CLOUDFLARE_API || 'https://api.cloudflare.com/client/v4';
const DOWNLOAD = process.env.ASTRA_CLOUDFLARED_URL || 'https://github.com/cloudflare/cloudflared/releases/latest/download';
// « …/releases/latest » redirige vers « …/releases/tag/<version> » : pas besoin de l'API GitHub (limitée).
const RELEASES = process.env.ASTRA_CLOUDFLARED_RELEASES || 'https://github.com/cloudflare/cloudflared/releases';
const LATEST_CHECK_EVERY = 12 * 3600_000;
const BINARIES = { arm64: 'cloudflared-linux-arm64', x64: 'cloudflared-linux-amd64', arm: 'cloudflared-linux-arm' };
const DNS_COMMENT = 'Géré par AstraPanel';
// Serveurs Minecraft : le tunnel ne transporte que le web. Leur domaine pointe donc directement sur l'adresse IP
// publique de la box (enregistrement A « DNS uniquement »), plus un enregistrement SRV si le port n'est pas 25565.
export const MC_DEFAULT_PORT = 25565;
const IP_CHECK_EVERY = 5 * 60_000; // adresse IP publique surveillée (box à IP dynamique)
const publicIpUrl = () => process.env.ASTRA_PUBLIC_IP_URL || 'https://1.1.1.1/cdn-cgi/trace';

// Adresse IPv4 publique de la machine, vue depuis Internet (service de Cloudflare, joint en IPv4)
export async function publicIp() {
  const res = await fetch(publicIpUrl(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const ip = (/^ip=(.+)$/m.exec(text)?.[1] || text).trim();
  if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(ip)) throw new Error('adresse IPv4 publique introuvable');
  return ip;
}

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
    this.latest = null; // dernière version publiée de cloudflared : { version, checkedAt, error }
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

  // Dernière version de cloudflared publiée sur GitHub.
  async checkLatest() {
    try {
      const res = await fetch(`${RELEASES}/latest`, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'User-Agent': 'AstraPanel' },
        signal: AbortSignal.timeout(15_000),
      });
      const version = /\/tag\/v?(\d+\.\d+\.\d+)\/?$/.exec(res.headers.get('location') || '')?.[1];
      if (!version) throw new Error(`réponse inattendue de GitHub (HTTP ${res.status})`);
      this.latest = { version, checkedAt: Date.now(), error: null };
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'GitHub ne répond pas' : err.message;
      this.latest = { version: this.latest?.version ?? null, checkedAt: Date.now(), error: `Vérification impossible : ${reason}` };
    }
    return this.latest;
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
    this.restartTimer = setTimeout(() => this.start().catch((err) => {
      this.log.system(`✖ ${err.message}`);
      this.handleStartFailure();
    }), delay);
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
      res = await fetch(`${apiBase()}${pathname}`, {
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

  /**
   * Comptes accessibles avec le jeton. La liste /accounts n'est remplie que si le jeton a la permission
   * « Account Settings », qu'on ne demande pas : on retrouve donc aussi le compte à partir des domaines
   * (zones), que le jeton peut lire grâce à « Zone Read ».
   */
  async accounts(apiToken = this.settings.api.apiToken) {
    const found = new Map();
    let firstError = null;
    try {
      for (const a of (await this.api('GET', '/accounts?per_page=50', undefined, apiToken)) || []) found.set(a.id, { id: a.id, name: a.name });
    } catch (err) {
      firstError = err;
    }
    if (!found.size) {
      let zones;
      try {
        zones = await this.api('GET', '/zones?per_page=50', undefined, apiToken);
      } catch (err) {
        throw firstError || err;
      }
      for (const z of zones || []) if (z.account?.id) found.set(z.account.id, { id: z.account.id, name: z.account.name || z.account.id });
    }
    return [...found.values()];
  }

  async connect(apiToken) {
    if (typeof apiToken !== 'string' || apiToken.trim().length < 20) throw new HttpError(400, 'Jeton d’API invalide');
    const token = apiToken.trim();
    const accounts = await this.accounts(token);
    if (!accounts.length) {
      throw new HttpError(
        400,
        'Aucun compte trouvé avec ce jeton. Vérifiez ses permissions (Cloudflare Tunnel : Modifier, DNS : Modifier, Zone : Lire, sur toutes les zones) et que votre domaine est bien ajouté à Cloudflare.',
      );
    }
    this.save({ api: { ...this.settings.api, apiToken: token } });
    return accounts;
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
    const add = (domain, port, label, kind = 'http') => {
      const hostname = hostnameOf(domain);
      if (seen.has(hostname)) return;
      seen.add(hostname);
      routes.push({ hostname, service: kind === 'minecraft' ? `minecraft://${hostname}:${port}` : `http://localhost:${port}`, label, kind, port });
    };
    if (settings.panelDomain) add(settings.panelDomain, this.config.port, 'Panel AstraPanel');
    for (const app of apps) if (app.port) for (const d of app.domains || []) add(d, app.port, app.name, app.type === 'minecraft' ? 'minecraft' : 'http');
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
    const tunnelReady = Boolean(enabled && mode === 'api' && api.tunnelId);
    const dnsReady = Boolean(mode === 'api' && api.apiToken && api.accountId);
    if (!tunnelReady && !dnsReady) return { ok: true, skipped: true };
    const all = this.desiredRoutes();
    const routes = all.filter((r) => r.kind !== 'minecraft');
    const mcRoutes = all.filter((r) => r.kind === 'minecraft');
    const target = `${api.tunnelId}.cfargotunnel.com`;
    try {
      const zones = await this.zones(api.accountId);
      if (tunnelReady) await this.syncSites(routes, zones, target, replace);
      else for (const r of routes) Object.assign(r, { status: 'error', message: 'Tunnel Cloudflare pas encore créé' });
      await this.syncMinecraft(mcRoutes, zones, replace);

      const done = [...routes, ...mcRoutes];
      const problems = done.filter((r) => r.status !== 'ok');
      this.lastSync = { at: Date.now(), routes: done, error: null };
      this.log.system(`Synchronisation Cloudflare : ${done.length - problems.length}/${done.length} domaine(s) publiés`);
      return problems.length
        ? { ok: false, routes: done, error: problems.map((r) => `${r.hostname} : ${r.message}`).join(' ; ') }
        : { ok: true, routes: done };
    } catch (err) {
      this.lastSync = { at: Date.now(), routes: all, error: err.message };
      this.log.system(`✖ Synchronisation Cloudflare : ${err.message}`);
      return { ok: false, routes: all, error: err.message };
    }
  }

  // Zone Cloudflare d'un nom d'hôte : la plus longue qui le contient (sous.domaine.fr → domaine.fr)
  zoneOf(zones, hostname) {
    return zones.filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
  }

  // Sites : règles du tunnel et enregistrements CNAME vers le tunnel
  async syncSites(routes, zones, target, replace) {
    const { api } = this.settings;
    await this.api('PUT', `/accounts/${api.accountId}/cfd_tunnel/${api.tunnelId}/configurations`, {
      config: {
        ingress: [...routes.map((r) => ({ hostname: r.hostname, service: r.service })), { service: 'http_status:404' }],
      },
    });
    const zoneOf = (hostname) => this.zoneOf(zones, hostname);

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
        if (r.type === 'CNAME' && r.content === target && r.comment === DNS_COMMENT && !wanted.has(r.name)) {
          await this.api('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
          this.log.system(`Enregistrement DNS ${r.name} supprimé (domaine retiré)`);
        }
      }
    }
  }

  // Serveurs Minecraft : A « DNS uniquement » vers l'adresse IP publique (+ SRV si le port n'est pas 25565)
  async syncMinecraft(routes, zones, replace) {
    let ip = null;
    if (routes.length) {
      try {
        ip = await publicIp();
        this.publicIp = ip;
      } catch (err) {
        for (const r of routes) Object.assign(r, { status: 'error', message: `Adresse IP publique introuvable : ${err.message}` });
      }
    }
    for (const route of ip ? routes : []) {
      const zone = this.zoneOf(zones, route.hostname);
      if (!zone) {
        Object.assign(route, { status: 'no-zone', message: 'Domaine absent de ce compte Cloudflare' });
        continue;
      }
      route.zone = zone.name;
      try {
        const records = (await this.api('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(route.hostname)}&per_page=50`)).filter((r) =>
          ['A', 'AAAA', 'CNAME'].includes(r.type),
        );
        const mine = records.find((r) => r.type === 'A' && r.comment === DNS_COMMENT);
        const others = records.filter((r) => r !== mine);
        if (others.length && (replace.includes(route.hostname) || others.every((r) => r.comment === DNS_COMMENT))) {
          for (const r of others) await this.api('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
        } else if (others.length) {
          const desc = others.map((r) => `${r.type} ${r.content}`).join(', ');
          Object.assign(route, { status: 'conflict', message: `Un enregistrement DNS existe déjà (${desc})` });
          continue;
        }
        const record = { type: 'A', name: route.hostname, content: ip, proxied: false, ttl: 300, comment: DNS_COMMENT };
        if (!mine) await this.api('POST', `/zones/${zone.id}/dns_records`, record);
        else if (mine.content !== ip || mine.proxied) {
          await this.api('PUT', `/zones/${zone.id}/dns_records/${mine.id}`, record);
          this.log.system(`${route.hostname} : adresse IP publique mise à jour (${mine.content} → ${ip})`);
        }
        // SRV : les joueurs tapent seulement le domaine, même si le port n'est pas celui de Minecraft
        const srvName = `_minecraft._tcp.${route.hostname}`;
        const srvs = (await this.api('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(srvName)}&per_page=50`)).filter((r) => r.type === 'SRV');
        const wantSrv = route.port !== MC_DEFAULT_PORT;
        const good = wantSrv ? srvs.find((r) => r.data?.port === route.port && r.data?.target === route.hostname) : null;
        for (const r of srvs) if (r !== good && r.comment === DNS_COMMENT) await this.api('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
        if (wantSrv && !good) {
          await this.api('POST', `/zones/${zone.id}/dns_records`, {
            type: 'SRV',
            name: srvName,
            data: { priority: 0, weight: 5, port: route.port, target: route.hostname },
            ttl: 300,
            comment: DNS_COMMENT,
          });
        }
        Object.assign(route, { status: 'ok', ip, message: `DNS uniquement → ${ip}${wantSrv ? `, port ${route.port} (SRV)` : ''}` });
      } catch (err) {
        Object.assign(route, { status: 'error', message: err.message });
      }
    }

    // Supprime les enregistrements A / SRV créés par le panel pour des serveurs Minecraft qui n'ont plus ce domaine.
    const wanted = new Set(routes.map((r) => r.hostname));
    for (const zone of zones) {
      const records = await this.api('GET', `/zones/${zone.id}/dns_records?comment=${encodeURIComponent(DNS_COMMENT)}&per_page=100`);
      for (const r of records) {
        if (r.comment !== DNS_COMMENT) continue;
        const host = r.type === 'A' ? r.name : r.type === 'SRV' && r.name.startsWith('_minecraft._tcp.') ? r.name.slice('_minecraft._tcp.'.length) : null;
        if (host && !wanted.has(host)) {
          await this.api('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
          this.log.system(`Enregistrement DNS ${r.type} ${r.name} supprimé (domaine retiré)`);
        }
      }
    }
  }

  // Box à adresse IP dynamique : si l'adresse publique change, les domaines Minecraft suivent.
  async watchPublicIp() {
    const { mode, api } = this.settings;
    if (mode !== 'api' || !api.apiToken || !this.desiredRoutes().some((r) => r.kind === 'minecraft')) return;
    let ip;
    try {
      ip = await publicIp();
    } catch {
      return;
    }
    if (ip === this.publicIp) return;
    if (this.publicIp) this.log.system(`Adresse IP publique changée (${this.publicIp} → ${ip}) : mise à jour des domaines Minecraft`);
    this.publicIp = ip;
    await this.sync();
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
    const version = await this.version(bin);
    return {
      binary: bin,
      version,
      latest: this.latest,
      updateAvailable: Boolean(version && this.latest?.version && compareVersions(this.latest.version, version) > 0),
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
      publicIp: this.publicIp || null,
    };
  }

  // Démarrage avec le panel : le tunnel est lancé en premier, avant les applications.
  async bootstrap() {
    this.startWatchdog();
    this.ipTimer = setInterval(() => this.watchPublicIp().catch(() => {}), IP_CHECK_EVERY);
    this.ipTimer.unref();
    // vérifie la dernière version de cloudflared peu après le démarrage, puis toutes les 12 heures
    const check = () => this.checkLatest().catch(() => {});
    this.latestTimer = setTimeout(() => {
      check();
      this.latestInterval = setInterval(check, LATEST_CHECK_EVERY);
      this.latestInterval.unref();
    }, 30_000);
    this.latestTimer.unref();
    if (!this.settings.enabled || !this.token()) return;
    try {
      await this.start();
      console.log('Tunnel Cloudflare démarré avec le panel');
    } catch (err) {
      // binaire absent… : on réessaie comme après un plantage plutôt que d'abandonner
      this.log.system(`✖ ${err.message}`);
      this.handleStartFailure();
    }
    if (this.settings.mode === 'api') this.sync().catch(() => {});
  }

  handleStartFailure() {
    if (!this.settings.enabled) return;
    this.crashCount += 1;
    const delay = Math.min(60_000, 2000 * 2 ** (this.crashCount - 1));
    this.log.system(`↻ Nouvel essai dans ${delay / 1000} s`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.start().catch((err) => {
      this.log.system(`✖ ${err.message}`);
      this.handleStartFailure();
    }), delay);
  }

  // Filet de sécurité : si cloudflared tourne mais reste sans connexion 5 minutes, on le relance.
  startWatchdog() {
    clearInterval(this.watchdog);
    let disconnectedSince = null;
    this.watchdog = setInterval(async () => {
      if (!this.child || !this.settings.enabled) {
        disconnectedSince = null;
        return;
      }
      const ready = await this.ready();
      if (ready?.readyConnections > 0) {
        disconnectedSince = null;
        return;
      }
      disconnectedSince ??= Date.now();
      if (Date.now() - disconnectedSince > 5 * 60_000) {
        disconnectedSince = null;
        this.log.system('Aucune connexion à Cloudflare depuis 5 minutes : redémarrage du tunnel');
        await this.restart().catch((err) => this.log.system(`✖ ${err.message}`));
      }
    }, 60_000);
    this.watchdog.unref();
  }

  async shutdown() {
    clearTimeout(this.restartTimer);
    clearTimeout(this.latestTimer);
    clearInterval(this.latestInterval);
    clearInterval(this.watchdog);
    clearInterval(this.ipTimer);
    await this.stop({ persist: false });
    this.log.close();
  }
}
