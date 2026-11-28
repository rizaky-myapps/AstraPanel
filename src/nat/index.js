import crypto from 'node:crypto';
import dns from 'node:dns';
import os from 'node:os';
import { HttpError } from '../http/util.js';
import { publicIp } from '../tunnel.js';
import { Freebox, RIGHTS_HELP } from './freebox.js';
import { localIpv4 } from './lan.js';
import { UpnpGateway } from './upnp.js';

// Gestion des ports de la box internet : ouvre (redirige) vers cette machine les ports des serveurs de jeux et
// les ports ajoutés à la main, pour qu'on puisse les joindre depuis Internet. Les sites n'en ont pas besoin :
// ils passent par le tunnel Cloudflare.
//
// Méthodes : « freebox » (API Freebox OS), « upnp » (la plupart des box), « manual » (le panel indique quoi
// créer dans la box). « auto » choisit d'après l'opérateur détecté. Les redirections créées par le panel portent
// le commentaire « AstraPanel · … » : celles des autres ne sont jamais touchées (sauf « Remplacer »).

export const METHODS = ['auto', 'freebox', 'upnp', 'manual'];
export const METHOD_LABELS = { freebox: 'API Freebox', upnp: 'UPnP', manual: 'Manuel' };
const TAG = 'AstraPanel';
const SYNC_EVERY = 5 * 60_000;
const PROTOS = ['tcp', 'udp', 'both'];
const MAX_RULES = 50;

export const OPERATORS = {
  free: { label: 'Free', admin: 'https://mafreebox.freebox.fr', where: 'Paramètres de la Freebox → Gestion des ports' },
  orange: { label: 'Orange', admin: 'http://192.168.1.1', where: 'Réseau → NAT/PAT' },
  sfr: { label: 'SFR', admin: 'http://192.168.1.1', where: 'Réseau v4 → NAT' },
  bouygues: { label: 'Bouygues Telecom', admin: 'https://mabbox.bytel.fr', where: 'Services de la box → Redirection de ports' },
  other: { label: 'Autre opérateur', admin: null, where: 'NAT / Redirection de ports' },
};

// Opérateur d'après ce que la box et le nom inverse de l'adresse IP publique laissent voir
export function guessOperator(text) {
  const t = String(text || '').toLowerCase();
  if (/freebox|proxad|iliad/.test(t)) return 'free';
  if (/livebox|orange|wanadoo|sosh/.test(t)) return 'orange';
  if (/bbox|bouygues|bytel/.test(t)) return 'bouygues';
  if (/\bsfr\b|sfr\.net|neufbox|numericable|red-by-sfr|\bnb[4-9]\b/.test(t)) return 'sfr';
  return null;
}

const comment = (label) => `${TAG} · ${String(label).slice(0, 40)}`;
const isOurs = (description) => String(description || '').startsWith(TAG);
const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

async function reverseNames(ip) {
  if (!ip) return [];
  const resolver = new dns.promises.Resolver({ timeout: 1500, tries: 1 });
  return resolver.reverse(ip).catch(() => []);
}

export class PortManager {
  constructor({ store, config, apps }) {
    this.store = store;
    this.config = config;
    this.apps = apps;
    this.state = null; // résultat de la dernière synchronisation
    this.running = null;
    this.timer = null;
    this.debounce = null;
    this.freebox = null;
    this.freeboxError = null;
  }

  get settings() {
    return this.store.data.settings.ports;
  }

  // Méthode réellement utilisée
  method() {
    const s = this.settings;
    return s.method === 'auto' ? s.detected?.method || 'manual' : s.method;
  }
  automatic(method = this.method()) {
    return method === 'freebox' || method === 'upnp';
  }

  fbx() {
    const s = this.settings.freebox;
    if (!this.freebox || this.freebox.appToken !== s.appToken) {
      this.freebox = new Freebox({
        appToken: s.appToken,
        httpsOnly: s.https,
        onHttps: () => {
          if (!this.settings.freebox.https) {
            this.settings.freebox.https = true;
            this.store.save();
          }
        },
      });
    }
    return this.freebox;
  }

  // ---- Détection de l'opérateur et de la méthode -----------------------------------------------------
  async detect() {
    const freebox = new Freebox({ httpsOnly: this.settings.freebox.https });
    const [fbxInfo, gateway] = await Promise.all([freebox.discover({ timeout: 2500 }).catch(() => null), UpnpGateway.find().catch(() => null)]);
    const upnpIp = gateway ? await gateway.externalIp().catch(() => null) : null;
    const ip = upnpIp || (await publicIp().catch(() => null));
    const names = await reverseNames(ip);
    const operator =
      (fbxInfo && 'free') ||
      guessOperator([gateway?.info.manufacturer, gateway?.info.modelName, gateway?.info.friendlyName, gateway?.info.modelDescription].join(' ')) ||
      guessOperator(names.join(' ')) ||
      (gateway || ip ? 'other' : null);
    const detected = {
      at: Date.now(),
      operator,
      label: OPERATORS[operator]?.label || null,
      box: fbxInfo ? freebox.model : gateway?.model || null,
      freebox: Boolean(fbxInfo),
      upnp: Boolean(gateway),
      publicIp: ip,
      reverse: names[0] || null,
      // méthode conseillée : l'API Freebox si possible, sinon l'UPnP, sinon à la main
      method: fbxInfo ? 'freebox' : gateway ? 'upnp' : 'manual',
    };
    this.settings.detected = detected;
    if (!detected.freebox) this.settings.portRange = null; // autre box : la plage de ports de la Freebox ne vaut plus
    this.store.save();
    this.schedule();
    return detected;
  }

  // ---- Réglages ----------------------------------------------------------------------------------------
  async update(input) {
    const s = this.settings;
    const before = { enabled: s.enabled, method: this.method() };
    if ('enabled' in input) s.enabled = input.enabled === true;
    if ('method' in input) {
      if (!METHODS.includes(input.method)) throw new HttpError(400, 'Méthode inconnue');
      s.method = input.method;
    }
    if ('skip' in input) {
      if (!Array.isArray(input.skip) || input.skip.some((id) => typeof id !== 'string')) throw new HttpError(400, 'Liste invalide');
      s.skip = [...new Set(input.skip)].filter((id) => this.apps.find(id));
    }
    this.store.save();
    // le panel ne gère plus les ports de la même façon : il retire les redirections qu'il avait créées
    const after = { enabled: s.enabled, method: this.method() };
    if (before.enabled && this.automatic(before.method) && (!after.enabled || after.method !== before.method)) await this.cleanup(before.method);
    return this.sync();
  }

  addRule({ name, proto, port, lanPort }) {
    const rule = {
      id: crypto.randomBytes(4).toString('hex'),
      name: String(name || '').trim().slice(0, 40),
      proto: String(proto || 'tcp').toLowerCase(),
      port: Number(port),
      lanPort: lanPort === undefined || lanPort === null || lanPort === '' ? Number(port) : Number(lanPort),
    };
    if (!rule.name) throw new HttpError(400, 'Donnez un nom à cette redirection');
    if (!PROTOS.includes(rule.proto)) throw new HttpError(400, 'Protocole inconnu (TCP, UDP ou les deux)');
    if (!validPort(rule.port) || !validPort(rule.lanPort)) throw new HttpError(400, 'Port invalide (1 à 65535)');
    if (!this.inRange(rule.port)) throw new HttpError(400, this.rangeError(rule.port));
    if (this.settings.rules.length >= MAX_RULES) throw new HttpError(400, `${MAX_RULES} redirections au maximum`);
    const used = this.desired().flatMap((e) => e.mappings.map((m) => ({ ...m, label: e.label })));
    const clash = used.find((m) => m.port === rule.port && (rule.proto === 'both' || m.proto === rule.proto));
    if (clash) throw new HttpError(409, `Le port ${rule.port} est déjà ouvert pour « ${clash.label} »`);
    this.settings.rules.push(rule);
    this.store.save();
    return this.sync();
  }

  async removeRule(id) {
    const s = this.settings;
    if (!s.rules.some((r) => r.id === id)) throw new HttpError(404, 'Redirection introuvable');
    s.rules = s.rules.filter((r) => r.id !== id);
    this.store.save();
    return this.sync();
  }

  // ---- Freebox : autorisation du panel ---------------------------------------------------------------
  async freeboxAuthorize() {
    const fbx = new Freebox({ httpsOnly: this.settings.freebox.https });
    const { appToken, trackId } = await fbx.authorize({ appName: 'AstraPanel', appVersion: this.config.version, deviceName: os.hostname() });
    Object.assign(this.settings.freebox, { appToken, trackId, status: 'pending' });
    this.store.save();
    this.freebox = null;
    return this.freeboxStatus();
  }

  // État de la connexion à la Freebox (et suite de la demande d'autorisation en attente)
  // refresh : nouvelle session (bouton « Vérifier », après avoir accordé le droit dans Freebox OS) ;
  // sinon la session en cours est réutilisée
  async freeboxStatus({ refresh = false } = {}) {
    const f = this.settings.freebox;
    if (f.appToken && f.trackId !== null && f.trackId !== undefined) {
      const status = await this.fbx()
        .authorizationStatus(f.trackId)
        .catch(() => 'pending');
      if (status !== 'pending') {
        f.trackId = null;
        f.status = status;
        if (status !== 'granted') f.appToken = '';
        this.store.save();
        this.freebox = null;
        if (status === 'granted') this.schedule();
      }
    }
    let rights = null;
    if (f.appToken && f.trackId === null) {
      try {
        rights = await this.fbx().canChangeSettings({ refresh });
        await this.refreshRange();
        this.freeboxError = null;
      } catch (err) {
        this.freeboxError = err.message;
      }
    }
    return {
      connected: Boolean(f.appToken) && f.trackId === null,
      pending: Boolean(f.appToken) && f.trackId !== null,
      // refus ou délai dépassé sur l'écran de la Freebox : on l'indique une fois
      outcome: !f.appToken ? f.status || null : null,
      rights,
      rightsHelp: RIGHTS_HELP,
      model: this.freebox?.info ? this.freebox.model : this.settings.detected?.freebox ? this.settings.detected.box : null,
      error: this.freeboxError,
    };
  }

  async freeboxForget() {
    if (this.settings.freebox.appToken && this.method() === 'freebox') await this.cleanup('freebox');
    Object.assign(this.settings.freebox, { appToken: '', trackId: null, status: null });
    this.settings.portRange = null; // plage de ports propre à la ligne Free : oubliée avec la Freebox
    this.store.save();
    this.freebox = null;
    return this.sync();
  }

  // ---- Ports joignables depuis Internet --------------------------------------------------------------
  // IPv4 partagée (Free) : la box n'ouvre qu'une plage de ports (par exemple 49152 à 65535). Mémorisée pour que les
  // serveurs de jeux et les redirections ajoutées à la main n'utilisent que des ports de cette plage.
  range() {
    return this.settings.portRange || null;
  }
  inRange(port) {
    const r = this.range();
    return !r || (port >= r[0] && port <= r[1]);
  }
  rangeError(port) {
    const [a, b] = this.range();
    return `Le port ${port} n’est pas joignable depuis Internet : votre box (IPv4 partagée) n’ouvre que les ports ${a} à ${b}`;
  }

  // Lit la plage auprès de la Freebox (session en cours) et la mémorise. Retourne l'état de la connexion.
  async refreshRange() {
    const conn = await this.fbx()
      .connection()
      .catch(() => null);
    if (!conn) return null;
    const r = Array.isArray(conn.ipv4_port_range) && conn.ipv4_port_range.length === 2 ? conn.ipv4_port_range.map(Number) : null;
    const range = r && (r[0] > 1 || r[1] < 65535) ? r : null;
    if (JSON.stringify(range) !== JSON.stringify(this.range())) {
      this.settings.portRange = range;
      this.store.save();
    }
    return conn;
  }

  // ---- Ports voulus ----------------------------------------------------------------------------------
  // [{ key, label, kind: 'game' | 'custom', appId?, ruleId?, open, mappings: [{ proto, port, lanPort }] }]
  desired() {
    const s = this.settings;
    const games = this.apps.apps
      .filter((a) => a.type === 'minecraft' && a.port)
      .map((a) => ({ key: `app:${a.id}`, label: a.name, kind: 'game', appId: a.id, open: !s.skip.includes(a.id), mappings: [{ proto: 'tcp', port: a.port, lanPort: a.port }] }));
    const custom = s.rules.map((r) => ({
      key: `rule:${r.id}`,
      label: r.name,
      kind: 'custom',
      ruleId: r.id,
      open: true,
      mappings: (r.proto === 'both' ? ['tcp', 'udp'] : [r.proto]).map((proto) => ({ proto, port: r.port, lanPort: r.lanPort })),
    }));
    return [...games, ...custom];
  }

  // Accès à la box selon la méthode : liste des redirections, ajout, modification, suppression
  async backend(method) {
    if (method === 'freebox') {
      const fbx = this.fbx();
      if (!this.settings.freebox.appToken || this.settings.freebox.trackId !== null) throw new HttpError(400, 'Connectez d’abord le panel à la Freebox (ci-dessus)');
      const conn = await this.refreshRange();
      const body = (m, lanIp) => ({ enabled: true, comment: m.description, ip_proto: m.proto, wan_port_start: m.port, wan_port_end: m.port, lan_ip: lanIp, lan_port: m.lanPort, src_ip: '0.0.0.0' });
      return {
        lanIp: await localIpv4(fbx.host),
        publicIp: conn?.ipv4 || null,
        // IPv4 partagée (Free) : seuls certains ports peuvent être ouverts
        portRange: this.range(),
        list: async () =>
          (await fbx.redirections()).map((r) => ({
            id: r.id,
            proto: r.ip_proto,
            start: Number(r.wan_port_start),
            end: Number(r.wan_port_end || r.wan_port_start),
            lanIp: r.lan_ip,
            lanPort: Number(r.lan_port),
            enabled: r.enabled !== false,
            description: r.comment || '',
          })),
        add: (m, lanIp) => fbx.addRedirection(body(m, lanIp)),
        update: (c, m, lanIp) => fbx.updateRedirection(c.id, body(m, lanIp)),
        remove: (c) => fbx.deleteRedirection(c.id),
      };
    }
    if (method === 'upnp') {
      const gw = await UpnpGateway.find();
      if (!gw) throw new HttpError(502, 'Aucune box UPnP ne répond : activez l’UPnP dans l’interface de votre box, ou choisissez la méthode « Manuel »');
      return {
        lanIp: await localIpv4(gw.host),
        publicIp: await gw.externalIp().catch(() => null),
        portRange: null,
        list: async () => (await gw.mappings()).map((m) => ({ ...m, id: `${m.proto}:${m.port}`, start: m.port, end: m.port })),
        add: (m, lanIp) => gw.add({ proto: m.proto, port: m.port, lanIp, lanPort: m.lanPort, description: m.description }),
        update: async (c, m, lanIp) => {
          await gw.remove({ proto: c.proto, port: c.start });
          await gw.add({ proto: m.proto, port: m.port, lanIp, lanPort: m.lanPort, description: m.description });
        },
        remove: (c) => gw.remove({ proto: c.proto, port: c.start }),
      };
    }
    throw new HttpError(400, 'Méthode sans accès à la box');
  }

  // Retire toutes les redirections créées par le panel (changement de méthode, désactivation)
  async cleanup(method) {
    try {
      const box = await this.backend(method);
      for (const c of await box.list()) if (isOurs(c.description)) await box.remove(c);
    } catch {
      // box injoignable : rien à faire de plus
    }
  }

  // ---- Synchronisation -------------------------------------------------------------------------------
  schedule() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.sync().catch(() => {}), 1500);
    this.debounce.unref?.();
  }

  // Une synchronisation à la fois : les demandes suivantes attendent leur tour (et voient l'état à jour)
  async sync({ replace = [] } = {}) {
    while (this.running) await this.running.catch(() => {});
    this.running = this.doSync(replace);
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  async doSync(replace) {
    const s = this.settings;
    const method = this.method();
    const entries = this.desired();
    const state = { at: Date.now(), enabled: s.enabled, method, ok: true, error: null, lanIp: null, publicIp: null, portRange: null, routes: [] };
    const route = (e, status, message = '', extra = {}) =>
      state.routes.push({
        key: e.key,
        label: e.label,
        kind: e.kind,
        appId: e.appId || null,
        ruleId: e.ruleId || null,
        open: e.open,
        proto: e.mappings.length > 1 ? 'both' : e.mappings[0].proto,
        port: e.mappings[0].port,
        lanPort: e.mappings[0].lanPort,
        status,
        message,
        ...extra,
      });

    if (!s.enabled || !this.automatic(method)) {
      state.lanIp = await localIpv4(this.settings.detected?.freebox ? this.fbx().host : null);
      for (const e of entries) route(e, !e.open ? 'closed' : s.enabled ? 'manual' : 'off');
      this.state = state;
      return state;
    }

    let box;
    try {
      box = await this.backend(method);
      state.lanIp = box.lanIp;
      state.publicIp = box.publicIp;
      state.portRange = box.portRange;
      const current = await box.list();
      const claimed = new Set();
      for (const e of entries) {
        if (!e.open) {
          route(e, 'closed');
          continue;
        }
        let status = 'ok';
        let message = '';
        const extra = {};
        for (const m0 of e.mappings) {
          const m = { ...m0, description: comment(e.label) };
          if (!this.inRange(m.port)) {
            status = 'error';
            message = `${this.rangeError(m.port)}. ${e.kind === 'game' ? 'Donnez-lui un port de cette plage' : 'Retirez-la et ajoutez-la avec un port de cette plage'}, ou demandez une IPv4 « full-stack » (gratuite) dans votre espace abonné Free.`;
            extra.outOfRange = true;
            continue;
          }
          const covering = current.filter((c) => c.proto === m.proto && c.start <= m.port && m.port <= c.end);
          const mine = covering.find((c) => isOurs(c.description) && c.start === m.port && c.end === m.port && !claimed.has(c));
          const foreign = covering.filter((c) => !isOurs(c.description));
          try {
            if (foreign.length) {
              if (!replace.includes(e.key)) {
                const f = foreign[0];
                status = 'conflict';
                message = `Le port ${m.port} (${m.proto.toUpperCase()}) est déjà redirigé vers ${f.lanIp}:${f.lanPort}${f.description ? ` (« ${f.description} »)` : ''}`;
                continue;
              }
              for (const f of foreign) await box.remove(f);
            }
            if (mine) {
              claimed.add(mine);
              if (mine.lanIp !== state.lanIp || mine.lanPort !== m.lanPort || !mine.enabled || mine.description !== m.description) await box.update(mine, m, state.lanIp);
            } else {
              await box.add(m, state.lanIp);
            }
          } catch (err) {
            // droit manquant sur la Freebox : vaut pour tous les ports, signalé une seule fois
            if (err.code === 'insufficient_rights') throw err;
            status = 'error';
            message = err.message;
          }
        }
        route(e, status, message, extra);
      }
      // redirections du panel qui ne servent plus (serveur supprimé, port fermé ou changé)
      for (const c of current) {
        if (isOurs(c.description) && !claimed.has(c) && !entries.some((e) => e.open && e.mappings.some((m) => m.proto === c.proto && m.port === c.start && c.start === c.end))) {
          await box.remove(c).catch(() => {});
        }
      }
    } catch (err) {
      state.ok = false;
      state.error = err.message;
      state.lanIp ??= await localIpv4(null);
      for (const e of entries) if (!state.routes.some((r) => r.key === e.key)) route(e, e.open ? 'error' : 'closed', e.open ? err.message : '');
    }
    if (state.routes.some((r) => r.status === 'error' || r.status === 'conflict')) state.ok = false;
    this.state = state;
    return state;
  }

  // ---- Lecture ----------------------------------------------------------------------------------------
  status() {
    const s = this.settings;
    const method = this.method();
    return {
      enabled: s.enabled,
      method: s.method,
      effective: method,
      automatic: this.automatic(method),
      detected: s.detected,
      operators: OPERATORS,
      rules: s.rules,
      skip: s.skip,
      range: this.range(),
      freebox: { connected: Boolean(s.freebox.appToken) && s.freebox.trackId === null, pending: Boolean(s.freebox.appToken) && s.freebox.trackId !== null },
      sync: this.state,
    };
  }

  // Ce qu'un serveur de jeux a besoin de savoir (onglet Paramètres du serveur) : son port est-il ouvert ?
  routeFor(appId) {
    const s = this.settings;
    const r = this.state?.routes.find((x) => x.appId === appId);
    return { enabled: s.enabled, method: this.method(), operator: s.detected?.label || null, status: r?.status || null, message: r?.message || '', lanIp: this.state?.lanIp || null };
  }

  // ---- Cycle de vie -----------------------------------------------------------------------------------
  bootstrap() {
    if (!this.settings.detected) this.detect().catch(() => {});
    else this.schedule();
    const f = this.settings.freebox;
    if (f.appToken && f.trackId === null && !this.settings.enabled) this.refreshRange().catch(() => {});
    // l'adresse de la machine ou de la box peut changer : redirections vérifiées régulièrement
    this.timer = setInterval(() => {
      if (this.settings.enabled && this.automatic()) this.sync().catch(() => {});
    }, SYNC_EVERY);
    this.timer.unref?.();
  }

  shutdown() {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
  }
}
