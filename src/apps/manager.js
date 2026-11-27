import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { HttpError } from '../http/util.js';
import { assertDomainsFree, normalizeDomains } from '../domains.js';
import { LogBuffer, stripAnsi } from './logs.js';
import { baseEnv, killGroup, pipeOutput, runCommand, runShell } from './process.js';
import { CLK_TCK, sampleProcessGroups } from './stats.js';
import { addrInUsePort, listProcesses, portOwner } from '../ports.js';

export const TYPES = ['bot', 'node', 'static'];
const SOURCES = ['empty', 'template', 'git', 'archive'];
const TASKS = { deploy: 'Déploiement', install: 'Installation des dépendances', build: 'Build' };
const STOP_TIMEOUT = 10000;
const MAX_RESTARTS = 10;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const GIT_URL_RE = /^(https?:\/\/|ssh:\/\/|git@)\S+$/;

const TEMPLATES = {
  bot: { dir: 'discord-bot', startCommand: 'node index.js' },
  node: { dir: 'node-site', startCommand: 'node server.js' },
  static: { dir: 'static-site', startCommand: '' },
};

const needsPort = (type) => type === 'node' || type === 'static';

function str(value, max, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `Champ invalide : ${field}`);
  const v = value.trim();
  if (v.length > max) throw new HttpError(400, `Champ trop long : ${field}`);
  return v;
}

function cleanEnv(env) {
  if (env == null) return {};
  if (typeof env !== 'object' || Array.isArray(env)) throw new HttpError(400, 'Variables d’environnement invalides');
  const entries = Object.entries(env);
  if (entries.length > 200) throw new HttpError(400, '200 variables maximum');
  const out = {};
  for (const [key, value] of entries) {
    if (!ENV_KEY_RE.test(key)) throw new HttpError(400, `Nom de variable invalide : ${key}`);
    if (typeof value !== 'string' || value.length > 20000) throw new HttpError(400, `Valeur invalide pour ${key}`);
    out[key] = value;
  }
  return out;
}

// Explication des erreurs de récupération Git les plus courantes (sortie de git → conseil en français)
export function gitHint(output, app) {
  const text = String(output || '');
  const https = /^https?:\/\//i.test(app?.git?.url || '');
  if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|Invalid username or password|Repository not found/i.test(text)) {
    return https
      ? 'dépôt privé (ou URL incorrecte) : ajoutez un jeton GitHub dans l’URL, https://<jeton>@github.com/moi/projet.git, ou utilisez une clé de déploiement SSH'
      : 'dépôt introuvable ou accès refusé : vérifiez l’URL et les droits de la clé de déploiement';
  }
  if (/Permission denied \(publickey\)|Host key verification failed|Could not read from remote repository/i.test(text)) {
    return 'accès SSH refusé : ajoutez la clé publique du panel dans GitHub (dépôt → Settings → Deploy keys)';
  }
  if (/couldn't find remote ref|Remote branch .* not found|invalid refspec/i.test(text)) {
    return `la branche « ${app?.git?.branch || 'par défaut'} » n’existe pas sur le dépôt : corrigez-la dans l’onglet Déploiement`;
  }
  if (/Could not resolve host|unable to access|Connection timed out|Network is unreachable/i.test(text)) {
    return 'dépôt injoignable : vérifiez la connexion Internet de la machine et l’URL du dépôt';
  }
  return null;
}

function cleanGit(git) {
  if (!git || !git.url) return null;
  const url = str(git.url, 1000, 'URL Git');
  const branch = str(git.branch, 200, 'branche');
  if (!GIT_URL_RE.test(url)) throw new HttpError(400, 'URL Git invalide (https://… ou git@…)');
  if (branch && (!BRANCH_RE.test(branch) || branch.startsWith('-') || branch.includes('..'))) {
    throw new HttpError(400, 'Nom de branche invalide');
  }
  return { url, branch };
}

function cleanRelDir(value) {
  const v = str(value, 300, 'dossier') || '.';
  const norm = path.posix.normalize(v.replace(/\\/g, '/')).replace(/^\/+/, '') || '.';
  if (norm === '..' || norm.startsWith('../')) throw new HttpError(400, 'Le dossier doit être dans celui de l’application');
  return norm;
}

function cleanPort(value) {
  if (value === null || value === '' || value === undefined) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HttpError(400, 'Port invalide (1024 à 65535)');
  return port;
}

// Masque un éventuel jeton dans une URL du type https://jeton@github.com/...
export function maskUrl(url) {
  return String(url).replace(/^(https?:\/\/)[^@/]+@/, '$1***@');
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

export class AppManager {
  constructor({ store, config, publish }) {
    this.store = store;
    // appelé quand les domaines ou les ports changent (tunnel Cloudflare)
    this.publish = publish || (async () => ({}));
    this.config = config;
    this.runtime = new Map();
    this.logs = new Map();
    this.shuttingDown = false;
    this.statsTimer = setInterval(() => this.sampleStats().catch(() => {}), 3000);
    this.statsTimer.unref();
  }

  get apps() {
    return this.store.data.apps;
  }

  find(id) {
    return this.apps.find((a) => a.id === id);
  }

  get(id) {
    const app = this.find(id);
    if (!app) throw new HttpError(404, 'Application introuvable');
    return app;
  }

  dir(app) {
    return path.join(this.config.appsDir, app.id);
  }

  rt(id) {
    let rt = this.runtime.get(id);
    if (!rt) {
      rt = {
        status: 'stopped',
        child: null,
        pid: null,
        startedAt: null,
        stopping: false,
        exitWaiters: [],
        restartTimer: null,
        crashCount: 0,
        lastExit: null,
        cpu: null,
        memory: null,
        prevTicks: null,
        busy: null,
        taskChild: null,
      };
      this.runtime.set(id, rt);
    }
    return rt;
  }

  logsFor(id) {
    let log = this.logs.get(id);
    if (!log) {
      log = new LogBuffer(path.join(this.config.logsDir, `${id}.log`), {
        maxLines: this.config.limits.logLines,
        maxFileBytes: this.config.limits.logFileBytes,
      });
      this.logs.set(id, log);
    }
    return log;
  }

  serialize(app) {
    const rt = this.rt(app.id);
    return {
      ...app,
      dir: this.dir(app),
      runtime: {
        status: rt.status,
        pid: rt.pid,
        startedAt: rt.child ? rt.startedAt : null,
        restarts: rt.crashCount,
        lastExit: rt.lastExit,
        cpu: rt.cpu,
        memory: rt.memory,
        busy: rt.busy,
        deployQueued: Boolean(rt.deployAfterTask),
        webhookRejectedAt: rt.webhookRejectedAt || null,
      },
    };
  }

  // --- Accès ----------------------------------------------------------------
  // Un administrateur voit toutes les applis ; un utilisateur, celles qu'il a créées ou dont il est membre.
  canAccess(user, app) {
    return Boolean(user && app && (user.role === 'admin' || app.ownerId === user.id || app.members.includes(user.id)));
  }

  // Seuls le créateur et les administrateurs gèrent la liste des utilisateurs d'une appli.
  canManageMembers(user, app) {
    return Boolean(user && app && (user.role === 'admin' || app.ownerId === user.id));
  }

  // Appli accessible par cet utilisateur ; sinon 404 (on ne révèle pas son existence).
  getFor(user, id) {
    const app = this.find(id);
    if (!app || !this.canAccess(user, app)) throw new HttpError(404, 'Application introuvable');
    return app;
  }

  list(user) {
    return this.apps.filter((app) => !user || this.canAccess(user, app)).map((app) => this.serialize(app));
  }

  // Liste affichée dans l'onglet Utilisateurs : le créateur (figé) puis les membres ; les administrateurs n'y
  // figurent pas (ils voient toutes les applis), sauf s'ils ont créé l'appli.
  members(user, id) {
    const app = this.getFor(user, id);
    const users = this.store.data.users;
    const byId = (uid) => users.find((u) => u.id === uid);
    const owner = byId(app.ownerId);
    const view = (u) => ({ id: u.id, username: u.username, role: u.role, avatar: u.avatar?.v || null });
    const members = app.members.map(byId).filter((u) => u && u.role !== 'admin' && u.id !== app.ownerId);
    const canManage = this.canManageMembers(user, app);
    return {
      owner: owner ? view(owner) : app.ownerId ? { id: app.ownerId, username: null, deleted: true } : null,
      members: members.map(view),
      canManage,
      // comptes qu'on peut ajouter : utilisateurs (non administrateurs) absents de la liste
      candidates: canManage
        ? users.filter((u) => u.role !== 'admin' && u.id !== app.ownerId && !app.members.includes(u.id)).map(view)
        : [],
    };
  }

  addMember(user, id, userId) {
    const app = this.getFor(user, id);
    if (!this.canManageMembers(user, app)) throw new HttpError(403, 'Seuls le créateur de l’application et les administrateurs gèrent ses utilisateurs');
    const target = this.store.data.users.find((u) => u.id === userId);
    if (!target) throw new HttpError(404, 'Utilisateur introuvable');
    if (target.role === 'admin') throw new HttpError(400, 'Les administrateurs ont déjà accès à toutes les applications');
    if (target.id === app.ownerId) throw new HttpError(400, 'Le créateur fait déjà partie de la liste');
    if (!app.members.includes(target.id)) {
      app.members.push(target.id);
      this.store.save();
      this.logsFor(app.id).system(`Accès donné à « ${target.username} » par « ${user.username} »`);
    }
    return this.members(user, id);
  }

  removeMember(user, id, userId) {
    const app = this.getFor(user, id);
    if (!this.canManageMembers(user, app)) throw new HttpError(403, 'Seuls le créateur de l’application et les administrateurs gèrent ses utilisateurs');
    if (userId === app.ownerId) throw new HttpError(400, 'Le créateur de l’application ne peut pas être retiré de la liste');
    if (app.members.includes(userId)) {
      app.members = app.members.filter((m) => m !== userId);
      this.store.save();
      const target = this.store.data.users.find((u) => u.id === userId);
      this.logsFor(app.id).system(`Accès retiré à « ${target?.username || userId} » par « ${user.username} »`);
    }
    return this.members(user, id);
  }

  // Compte supprimé : il disparaît des listes (ses applis gardent leur créateur, affiché « compte supprimé »).
  forgetUser(userId) {
    let changed = false;
    for (const app of this.apps) {
      if (app.members.includes(userId)) {
        app.members = app.members.filter((m) => m !== userId);
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  makeId(name) {
    const slug =
      name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'app';
    let id;
    do id = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
    while (this.find(id));
    return id;
  }

  async allocatePort(exceptId = null) {
    const { start, end } = this.store.data.settings.portRange;
    const used = new Set(this.apps.filter((a) => a.id !== exceptId && a.port).map((a) => a.port));
    used.add(this.config.port);
    for (let port = start; port <= end; port++) {
      if (!used.has(port) && (await isPortFree(port))) return port;
    }
    throw new HttpError(409, `Aucun port libre entre ${start} et ${end}`);
  }

  // Valide et applique les champs modifiables sur `app` (appelé sur une copie lors d'une mise à jour).
  applyFields(app, input) {
    if ('name' in input) {
      app.name = str(input.name, 60, 'nom');
      if (!app.name) throw new HttpError(400, 'Le nom est obligatoire');
    }
    for (const key of ['startCommand', 'installCommand', 'buildCommand']) {
      if (key in input) app[key] = str(input[key], 1000, key);
    }
    if (app.type !== 'static' && !app.startCommand) throw new HttpError(400, 'La commande de démarrage est obligatoire');
    if ('staticDir' in input) app.staticDir = cleanRelDir(input.staticDir);
    if ('spa' in input) app.spa = Boolean(input.spa);
    if ('autoRestart' in input) app.autoRestart = Boolean(input.autoRestart);
    if ('startOnBoot' in input) app.startOnBoot = Boolean(input.startOnBoot);
    if ('env' in input) app.env = cleanEnv(input.env);
    if ('git' in input) app.git = cleanGit(input.git);
    if ('domains' in input) {
      const domains = normalizeDomains(input.domains);
      if (domains.length && !needsPort(app.type)) throw new HttpError(400, 'Un bot ne peut pas avoir de domaine');
      assertDomainsFree(this.store, domains, app.id);
      app.domains = domains;
    }
    if ('port' in input && needsPort(app.type)) {
      const port = cleanPort(input.port);
      if (port === this.config.port) throw new HttpError(409, `Le port ${port} est celui du panel AstraPanel lui-même : choisissez-en un autre`);
      const other = port && this.apps.find((a) => a.id !== app.id && a.port === port);
      if (other) throw new HttpError(409, `Le port ${port} est déjà utilisé par « ${other.name} »`);
      app.port = port;
    }
  }

  async create(input, user = null) {
    const { type } = input;
    if (!TYPES.includes(type)) throw new HttpError(400, 'Type d’application invalide');
    const source = input.source || 'empty';
    if (!SOURCES.includes(source)) throw new HttpError(400, 'Source invalide');
    const name = str(input.name, 60, 'nom');
    if (!name) throw new HttpError(400, 'Le nom est obligatoire');

    const app = {
      id: this.makeId(name),
      name,
      type,
      startCommand: source === 'template' ? TEMPLATES[type].startCommand : type === 'static' ? '' : 'npm start',
      installCommand: 'npm install',
      buildCommand: '',
      staticDir: '.',
      spa: false,
      port: null,
      domains: [],
      env: {},
      autoRestart: true,
      startOnBoot: true,
      git: null,
      desired: 'stopped',
      ownerId: user?.id ?? null, // créateur : toujours dans la liste des utilisateurs de l'appli
      members: [],
      webhookToken: crypto.randomBytes(24).toString('base64url'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.applyFields(app, input);
    if (source === 'git' && !app.git) throw new HttpError(400, 'L’URL du dépôt Git est obligatoire');
    if (needsPort(type) && !app.port) app.port = await this.allocatePort();

    await mkdir(this.dir(app), { recursive: true });
    if (source === 'template') {
      await cp(path.join(this.config.templatesDir, TEMPLATES[type].dir), this.dir(app), { recursive: true });
    }
    this.apps.push(app);
    this.store.save();
    this.logsFor(app.id).system(`Application « ${app.name} » créée`);

    const routing = app.domains.length ? await this.publish() : {};
    if (source === 'git' || source === 'template') this.runTask(app.id, 'deploy', { start: Boolean(input.start) });
    return { app: this.serialize(app), ...routing };
  }

  async update(id, input) {
    const app = this.get(id);
    const copy = structuredClone(app);
    this.applyFields(copy, input);
    if (needsPort(copy.type) && !copy.port) copy.port = await this.allocatePort(copy.id);
    const routingChanged = JSON.stringify([app.domains, app.port]) !== JSON.stringify([copy.domains, copy.port]);
    Object.assign(app, copy, { updatedAt: Date.now() });
    this.store.save();
    const routing = routingChanged ? await this.publish() : {};
    return { app: this.serialize(app), ...routing };
  }

  async remove(id) {
    const app = this.get(id);
    const rt = this.rt(id);
    app.desired = 'stopped';
    clearTimeout(rt.restartTimer);
    if (rt.taskChild) killGroup(rt.taskChild.pid, 'SIGKILL');
    if (rt.child) await this.terminate(app);
    this.store.data.apps = this.apps.filter((a) => a.id !== id);
    this.store.save();
    this.logs.get(id)?.close();
    this.logs.delete(id);
    this.runtime.delete(id);
    const logFile = path.join(this.config.logsDir, `${id}.log`);
    await Promise.all([rm(logFile, { force: true }), rm(`${logFile}.1`, { force: true })]);
    await rm(this.dir(app), { recursive: true, force: true });
    return app.domains?.length ? this.publish() : {};
  }

  appEnv(app, extra = {}) {
    const userEnv = app.env || {};
    const env = {
      ...baseEnv(),
      npm_config_update_notifier: 'false',
      // couleurs : sans terminal, la plupart des outils n'en mettent pas ; on les force (chalk, Node, npm…) pour que
      // la console du panel affiche les couleurs choisies par l'application (sauf si elle règle elle-même
      // FORCE_COLOR ou NO_COLOR dans ses variables)
      ...('FORCE_COLOR' in userEnv || 'NO_COLOR' in userEnv ? {} : { FORCE_COLOR: '3' }),
      COLORTERM: 'truecolor',
      ...extra,
      ...app.env,
      ASTRA_APP_ID: app.id,
      ASTRA_APP_NAME: app.name,
    };
    if (app.port) env.PORT = String(app.port);
    return env;
  }

  // --- Ports -----------------------------------------------------------------
  // Qui occupe ce port ? Une appli du panel, un ancien processus d'une appli resté en marche, ou autre chose.
  async describePort(port) {
    if (port === this.config.port) return { text: `le panel AstraPanel lui-même (port ${port})` };
    const owner = await portOwner(port);
    if (!owner) return { text: 'un autre programme' };
    if (!owner.pid) return { text: 'un programme d’un autre compte du système (par exemple un service installé à part)' };
    if (owner.pid === process.pid) return { text: 'le panel AstraPanel lui-même' };
    const cmd = owner.command.length > 100 ? `${owner.command.slice(0, 99)}…` : owner.command || '?';
    const running = this.apps.find((a) => {
      const pid = this.runtime.get(a.id)?.pid;
      return pid && (pid === owner.pid || pid === owner.pgid);
    });
    if (running) return { text: `l'application « ${running.name} » (PID ${owner.pid} : ${cmd})`, app: running.id };
    // processus lancé depuis le dossier d'une appli mais qui n'est plus suivi par le panel (orphelin)
    const rel = owner.cwd ? path.relative(this.config.appsDir, owner.cwd) : '..';
    const leftover = !rel.startsWith('..') && !path.isAbsolute(rel) && this.find(rel.split(path.sep)[0]);
    if (leftover) {
      return {
        text: `un ancien processus de l'application « ${leftover.name} » resté en marche (PID ${owner.pid} : ${cmd})`,
        leftoverOf: leftover.id,
        pid: owner.pid,
        pgid: owner.pgid,
      };
    }
    return { text: `un autre programme (PID ${owner.pid} : ${cmd})` };
  }

  // Arrête un ancien processus orphelin d'une appli (et son groupe), en attendant sa fin.
  async killLeftover({ pid, pgid }) {
    const group = pgid && pgid !== process.pid ? pgid : null;
    const signal = (sig) => (group ? killGroup(group, sig) : (() => { try { process.kill(pid, sig); return true; } catch { return false; } })());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    signal('SIGTERM');
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    if (alive()) signal('SIGKILL');
    for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  }

  // --- Processus restés en arrière-plan ----------------------------------------
  // Le code d'AstraPanel ne peut pas tourner comme application du panel (un panel dans le panel) : il garde des
  // processus en arrière-plan que le panel ne suit pas, et se dispute les ports avec lui.
  isAstraPanelCode(app) {
    if (app.type === 'static') return false;
    const dir = this.dir(app);
    const isPanel = (base) => {
      try {
        if (JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8')).name === 'astrapanel') return true;
      } catch {
        // pas de package.json lisible
      }
      return existsSync(path.join(base, 'src', 'apps', 'manager.js')) && existsSync(path.join(base, 'src', 'server.js'));
    };
    if (isPanel(dir)) return true;
    // dépôt cloné dans un sous-dossier (« cd AstraPanel && npm start »)
    try {
      return readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && isPanel(path.join(dir, e.name)));
    } catch {
      return false;
    }
  }

  // Processus lancés depuis le dossier de l'appli mais que le panel ne suit pas (restés en arrière-plan : ancienne
  // instance, programme qui se détache, lancement à la main…). Les tâches en cours du panel sont exclues.
  async strays(app) {
    const dir = this.dir(app) + path.sep;
    const tracked = new Set();
    for (const rt of this.runtime.values()) {
      if (rt.pid) tracked.add(rt.pid);
      if (rt.taskChild?.pid) tracked.add(rt.taskChild.pid);
    }
    return (await listProcesses()).filter(
      (p) => p.pid !== process.pid && p.ppid !== process.pid && !tracked.has(p.pgid) && !tracked.has(p.pid) && `${p.cwd}${path.sep}`.startsWith(dir),
    );
  }

  // Arrête ces processus : ce que le panel affiche (arrêté, planté) correspond alors à ce qui tourne vraiment.
  async reapStrays(app) {
    const strays = await this.strays(app);
    if (!strays.length) return 0;
    const log = this.logsFor(app.id);
    for (const p of strays.slice(0, 5)) log.system(`Processus resté en arrière-plan arrêté (PID ${p.pid} : ${p.command.slice(0, 100) || '?'})`);
    if (strays.length > 5) log.system(`… et ${strays.length - 5} autre(s)`);
    // tout le groupe si son chef est lui-même un processus égaré, sinon ce processus seul
    const strayPids = new Set(strays.map((p) => p.pid));
    await Promise.all(strays.map((p) => this.killLeftover({ pid: p.pid, pgid: strayPids.has(p.pgid) ? p.pgid : null })));
    return strays.length;
  }

  // Démarre l'appli après avoir vérifié que son port est libre. Un ancien processus de la même appli resté en marche
  // est arrêté ; sinon l'appli n'est pas lancée et la console explique qui occupe le port.
  async launch(app, { userAction = false } = {}) {
    const rt = this.rt(app.id);
    if (rt.child) return;
    if (this.isAstraPanelCode(app)) {
      const message = 'Cette application contient AstraPanel lui-même : un panel ne peut pas être lancé comme application du panel';
      this.logsFor(app.id).system(`✖ ${message}. Supprimez-la ; pour mettre le panel à jour, utilisez Paramètres → Mises à jour.`);
      app.desired = 'stopped';
      this.store.save();
      rt.status = 'stopped';
      if (userAction) {
        const err = new HttpError(409, message);
        err.logged = true;
        throw err;
      }
      return;
    }
    await this.reapStrays(app);
    if (rt.child) return;
    if (app.port && needsPort(app.type) && !(await isPortFree(app.port))) {
      const log = this.logsFor(app.id);
      let who = await this.describePort(app.port);
      if (who.leftoverOf === app.id) {
        log.system(`Une ancienne instance de l’application occupe encore le port ${app.port} (PID ${who.pid}) : arrêt…`);
        await this.killLeftover(who);
        who = (await isPortFree(app.port)) ? null : await this.describePort(app.port);
      }
      if (who) {
        const message = `Le port ${app.port} est déjà utilisé par ${who.text}`;
        log.system(`✖ ${message} : l’application ne peut pas démarrer. Choisissez un autre port (onglet Paramètres) ou arrêtez ce programme.`);
        rt.status = 'crashed';
        if (userAction) {
          const err = new HttpError(409, message);
          err.logged = true; // déjà expliqué dans la console
          throw err;
        }
        return;
      }
    }
    if (!rt.child && app.desired === 'running' && this.find(app.id)) this.spawnApp(app);
  }

  // Après un plantage « EADDRINUSE » : qui occupe le port, et le code écoute-t-il bien sur PORT ?
  async explainAddrInUse(app, port) {
    const log = this.logsFor(app.id);
    const who = await this.describePort(port);
    log.system(`Le port ${port} est déjà utilisé par ${who.text}.`);
    if (app.port && port !== app.port) {
      log.system(`Votre code écoute sur le port ${port}, alors que le panel lui a attribué le port ${app.port} (variable PORT) : utilisez process.env.PORT dans votre code.`);
    } else if (!app.port) {
      log.system('Un bot n’a pas de port attribué : si votre code ouvre un serveur web, créez plutôt un « Site Node.js ».');
    }
  }

  spawnApp(app) {
    const rt = this.rt(app.id);
    if (rt.child) return;
    const log = this.logsFor(app.id);
    const cwd = this.dir(app);
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
    const env = this.appEnv(app, { NODE_ENV: 'production' });

    let command;
    let args;
    let display;
    if (app.type === 'static') {
      env.STATIC_ROOT = path.resolve(cwd, app.staticDir || '.');
      env.STATIC_SPA = app.spa ? '1' : '0';
      command = process.execPath;
      args = [this.config.staticServer];
      display = `serveur statique (dossier « ${app.staticDir} »)`;
    } else {
      command = '/bin/sh';
      args = ['-c', app.startCommand];
      display = app.startCommand;
    }
    log.system(`▶ Démarrage : ${display}${app.port ? ` — port ${app.port}` : ''}`);

    let child;
    try {
      // detached : l'app a son propre groupe de processus, qu'on peut arrêter en entier.
      child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      log.system(`✖ Impossible de démarrer : ${err.message}`);
      rt.status = 'crashed';
      return;
    }
    Object.assign(rt, {
      child,
      pid: child.pid,
      status: 'running',
      startedAt: Date.now(),
      stopping: false,
      cpu: null,
      memory: null,
      prevTicks: null,
    });
    child.stdin.on('error', () => {});
    pipeOutput(child, log);
    let exited = false;
    const onExit = (code, signal) => {
      if (exited) return;
      exited = true;
      this.handleExit(app.id, child, code, signal);
    };
    child.on('exit', onExit);
    child.on('error', (err) => {
      log.system(`✖ Erreur : ${err.message}`);
      onExit(null, null);
    });
  }

  handleExit(id, child, code, signal) {
    const rt = this.runtime.get(id);
    if (!rt || rt.child !== child) return;
    killGroup(child.pid, 'SIGKILL'); // processus orphelins éventuels du groupe
    const log = this.logsFor(id);
    const uptime = Date.now() - rt.startedAt;
    Object.assign(rt, { child: null, pid: null, cpu: null, memory: null, lastExit: { code, signal, at: Date.now() } });
    const waiters = rt.exitWaiters.splice(0);
    const how = signal ? `signal ${signal}` : `code ${code}`;

    const stopped = this.find(id);
    if (rt.stopping || this.shuttingDown) {
      rt.stopping = false;
      rt.status = 'stopped';
      log.system(`■ Arrêté (${how})`);
      if (stopped && !this.shuttingDown) this.reapStrays(stopped).catch(() => {});
      waiters.forEach((fn) => fn());
      return;
    }

    waiters.forEach((fn) => fn());
    log.system(`✖ Le processus s’est arrêté de façon inattendue (${how})`);
    rt.status = 'crashed';
    const busyPort = addrInUsePort(stripAnsi(log.lines.filter((l) => l.t >= rt.startedAt - 1000).map((l) => l.m).join('\n')));
    const crashed = this.find(id);
    if (busyPort && crashed) this.explainAddrInUse(crashed, busyPort).catch(() => {});
    // commande qui lance le vrai programme en arrière-plan puis se termine : le panel ne peut pas le surveiller
    if (crashed) {
      this.reapStrays(crashed)
        .then((n) => {
          if (n) log.system('Votre commande de démarrage a lancé un programme en arrière-plan puis s’est terminée : le panel ne peut pas le surveiller. Lancez le serveur directement (par exemple node server.js), sans « & », pm2 ni nohup.');
        })
        .catch(() => {});
    }
    if (uptime > 60000) rt.crashCount = 0;
    rt.crashCount += 1;

    const app = this.find(id);
    if (!app?.autoRestart || app.desired !== 'running') return;
    if (rt.crashCount > MAX_RESTARTS) {
      log.system(`Trop de plantages d’affilée : redémarrage automatique suspendu. Corrigez l’erreur puis cliquez sur « Démarrer ».`);
      return;
    }
    const delay = Math.min(30000, 1000 * 2 ** (rt.crashCount - 1));
    rt.status = 'restarting';
    log.system(`↻ Redémarrage automatique dans ${delay / 1000} s (tentative ${rt.crashCount}/${MAX_RESTARTS})`);
    rt.restartTimer = setTimeout(() => {
      rt.restartTimer = null;
      const current = this.find(id);
      if (current?.desired === 'running' && !this.shuttingDown) this.launch(current).catch(() => {});
    }, delay);
  }

  // SIGTERM au groupe de processus, puis SIGKILL si l'app ne s'arrête pas à temps.
  terminate(app) {
    const rt = this.rt(app.id);
    const { child } = rt;
    if (!child) return Promise.resolve();
    rt.stopping = true;
    rt.status = 'stopping';
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.logsFor(app.id).system('Arrêt forcé (SIGKILL) : le processus ne répondait pas');
        killGroup(child.pid, 'SIGKILL');
      }, STOP_TIMEOUT);
      rt.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      if (!killGroup(child.pid, 'SIGTERM')) child.kill('SIGTERM');
    });
  }

  assertIdle(rt) {
    if (rt.busy) throw new HttpError(409, 'Une tâche est en cours pour cette application, patientez');
  }

  async start(id) {
    const app = this.get(id);
    const rt = this.rt(id);
    this.assertIdle(rt);
    app.desired = 'running';
    this.store.save();
    rt.crashCount = 0;
    clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
    await this.launch(app, { userAction: true });
    return this.serialize(app);
  }

  async stop(id) {
    const app = this.get(id);
    const rt = this.rt(id);
    app.desired = 'stopped';
    this.store.save();
    clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
    if (rt.child) await this.terminate(app);
    else rt.status = 'stopped';
    return this.serialize(app);
  }

  async restart(id) {
    const app = this.get(id);
    const rt = this.rt(id);
    this.assertIdle(rt);
    app.desired = 'running';
    this.store.save();
    clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
    rt.crashCount = 0;
    if (rt.child) {
      this.logsFor(id).system('↻ Redémarrage…');
      await this.terminate(app);
    }
    // « Arrêter » a pu être demandé pendant l'arrêt : on ne relance pas dans ce cas.
    if (app.desired === 'running' && this.find(id)) await this.launch(app, { userAction: true });
    return this.serialize(app);
  }

  kill(id) {
    const app = this.get(id);
    const rt = this.rt(id);
    app.desired = 'stopped';
    this.store.save();
    clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
    if (rt.child) {
      rt.stopping = true;
      this.logsFor(id).system('Arrêt forcé demandé (SIGKILL)');
      killGroup(rt.child.pid, 'SIGKILL');
    } else {
      rt.status = 'stopped';
    }
    return this.serialize(app);
  }

  sendInput(id, text) {
    this.get(id);
    const rt = this.rt(id);
    if (!rt.child?.stdin?.writable) throw new HttpError(409, 'L’application n’est pas en cours d’exécution');
    this.logsFor(id).system(`> ${text}`);
    rt.child.stdin.write(`${text}\n`);
  }

  regenerateWebhook(id) {
    const app = this.get(id);
    app.webhookToken = crypto.randomBytes(24).toString('base64url');
    this.store.save();
    return app.webhookToken;
  }

  checkWebhook(id, token) {
    const app = this.find(id);
    if (!app?.webhookToken || typeof token !== 'string') return null;
    const a = Buffer.from(token);
    const b = Buffer.from(app.webhookToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? app : null;
  }

  // Appel avec une mauvaise adresse (ancienne adresse après « nouvelle adresse », copie incomplète…) : signalé dans
  // l'onglet Déploiement, sans rien écrire dans la console (n'importe qui peut appeler cette adresse).
  noteRejectedWebhook(id) {
    if (this.find(id)) this.rt(id).webhookRejectedAt = Date.now();
  }

  // Les 10 derniers appels reçus, affichés dans l'onglet Déploiement.
  noteWebhook(app, entry) {
    const saved = { at: Date.now(), ...entry };
    app.webhookLog = [saved, ...(app.webhookLog || [])].slice(0, 10);
    this.store.save();
    return saved;
  }

  // Résultat du déploiement lancé par un appel, ajouté à sa ligne de l'historique
  webhookOutcome(entry) {
    return (err) => {
      entry.outcome = err ? 'failed' : 'ok';
      if (err) entry.error = String(err.message || err).split('\n')[0].slice(0, 200);
      entry.doneAt = Date.now();
      this.store.save();
    };
  }

  /**
   * Appel du webhook de déploiement (adresse déjà vérifiée). `provider` : GitHub, GitLab, Gitea… (d'après les
   * en-têtes) ; `event` : type d'événement ; `payload` : corps JSON. Chaque appel est noté et expliqué dans la
   * console : on voit tout de suite si un push a été ignoré, et pourquoi.
   */
  handleWebhook(id, { provider = null, event = null, payload = null } = {}) {
    const app = this.get(id);
    const rt = this.rt(id);
    const log = this.logsFor(id);
    const from = provider || 'Le dépôt';
    const note = (kind, detail, extra = {}) => this.noteWebhook(app, { kind, provider, event, detail, ...extra }).detail;
    const p = payload && typeof payload === 'object' ? payload : {};

    // Test de l'adresse envoyé à la création du webhook (GitHub : « ping »)
    if (event === 'ping' || (p.zen && p.hook_id)) {
      log.system(`🔗 Webhook relié : ${from} joint bien le panel`);
      return { ok: true, message: note('ping', `${from} joint bien le panel (test de l'adresse)`) };
    }
    if (event && !/push/i.test(event)) {
      return { ok: true, skipped: note('ignored', `Événement « ${event} » ignoré : seuls les push déclenchent un déploiement`) };
    }

    const ref = typeof p.ref === 'string' ? p.ref : null;
    const branch = ref?.startsWith('refs/heads/') ? ref.slice(11) : null;
    const sha = p.after || p.checkout_sha || p.head_commit?.id || null;
    const commits = Array.isArray(p.commits) ? p.commits : [];
    const commit = p.head_commit || commits.find((c) => c?.id === sha) || commits.at(-1) || null;
    const info = {
      branch,
      commit: typeof sha === 'string' && !/^0+$/.test(sha) ? sha.slice(0, 7) : null,
      message: typeof commit?.message === 'string' ? commit.message.split('\n')[0].slice(0, 120) : null,
      author: p.pusher?.name || p.sender?.login || p.user_username || p.user_name || null,
    };

    if (ref?.startsWith('refs/tags/')) {
      return { ok: true, skipped: note('ignored', `Tag ${ref.slice(10)} ignoré : seuls les push sur une branche déclenchent un déploiement`, info) };
    }
    if (p.deleted === true) {
      return { ok: true, skipped: note('ignored', `Suppression de la branche ${branch || ref} ignorée`, info) };
    }
    if (!app.git) {
      const detail = note('error', 'Cette application n’est liée à aucun dépôt Git : renseignez-le dans l’onglet Déploiement', info);
      log.system(`✖ Webhook : ${detail}`);
      throw new HttpError(400, detail);
    }
    // branche suivie : celle réglée dans le panel, sinon la branche par défaut du dépôt (indiquée dans l'appel)
    const tracked = app.git.branch || p.repository?.default_branch || p.project?.default_branch || null;
    if (branch && tracked && branch !== tracked) {
      const detail = note('ignored', `Push sur la branche ${branch} ignoré : la branche suivie est ${tracked}${app.git.branch ? '' : ' (branche par défaut du dépôt)'}`, info);
      log.system(`Webhook : ${detail}`);
      return { ok: true, skipped: detail };
    }

    const what = [
      branch ? `Push sur ${branch}` : 'Appel',
      info.commit ? `${info.commit}${info.message ? ` « ${info.message} »` : ''}` : '',
      info.author ? `par ${info.author}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    // une tâche est en cours (autre déploiement, installation…) : le déploiement suivra, pour ne perdre aucun push
    if (rt.busy) {
      // plusieurs push pendant la tâche : un seul déploiement suivra (il récupère le dernier commit)
      if (rt.deployAfterTask) rt.deployAfterTask.outcome = 'merged'; // compris dans le déploiement qui suivra
      const entry = this.noteWebhook(app, { kind: 'queued', provider, event, detail: `${what} : déploiement en attente de la tâche en cours`, ...info });
      rt.deployAfterTask = entry;
      log.system(`Webhook (${from}) : ${entry.detail}`);
      return { ok: true, queued: true, message: entry.detail };
    }
    log.system(`Déploiement déclenché par webhook (${from}) : ${what}`);
    const entry = this.noteWebhook(app, { kind: 'deploy', provider, event, detail: `${what} : déploiement lancé`, ...info });
    this.runTask(id, 'deploy', { onDone: this.webhookOutcome(entry) });
    return { ok: true, started: true };
  }

  // Fin d'une tâche : lance le déploiement demandé par un webhook pendant qu'elle tournait.
  runQueuedDeploy(id) {
    const rt = this.rt(id);
    if (!rt.deployAfterTask || rt.busy || !this.find(id)) return;
    const entry = rt.deployAfterTask;
    rt.deployAfterTask = null;
    const done = this.webhookOutcome(entry);
    const log = this.logsFor(id);
    log.system('Déploiement en attente (webhook) : lancement');
    try {
      this.runTask(id, 'deploy', { onDone: done });
    } catch (err) {
      log.system(`✖ ${err.message}`);
      done?.(err);
    }
  }

  // Tâches longues (déploiement, npm install, build) : lancées en arrière-plan, sortie dans la console.
  runTask(id, task, { start = false, onDone = null } = {}) {
    const app = this.get(id);
    const rt = this.rt(id);
    if (!TASKS[task]) throw new HttpError(400, 'Tâche inconnue');
    this.assertIdle(rt);
    rt.busy = task;
    const log = this.logsFor(id);
    const label = TASKS[task];
    const begin = Date.now();
    log.system(`━━━ ${label} ━━━`);

    (async () => {
      try {
        if (task === 'deploy' && app.git) await this.gitSync(app, log);
        if (task === 'deploy' || task === 'install') await this.install(app, log, task === 'install');
        if (task === 'deploy' || task === 'build') await this.build(app, log, task === 'build');
        log.system(`✔ ${label} terminé en ${((Date.now() - begin) / 1000).toFixed(1)} s`);
        onDone?.(null);
        if (task === 'deploy' && this.find(id) && (start || rt.child || app.desired === 'running')) {
          rt.busy = null;
          await this.restart(id);
        }
      } catch (err) {
        if (this.find(id) && !err.logged) log.system(`✖ ${err.message}`);
        onDone?.(err);
      } finally {
        rt.busy = null;
        rt.taskChild = null;
        setImmediate(() => this.runQueuedDeploy(id));
      }
    })();
    return this.serialize(app);
  }

  cancelTask(id) {
    const rt = this.rt(id);
    if (!rt.busy) throw new HttpError(409, 'Aucune tâche en cours');
    if (rt.taskChild) killGroup(rt.taskChild.pid, 'SIGKILL');
    this.logsFor(id).system('Annulation demandée');
  }

  taskOptions(app, log, label, env) {
    const rt = this.rt(app.id);
    return {
      cwd: this.dir(app),
      env,
      log,
      label,
      onSpawn: (child) => {
        rt.taskChild = child;
      },
    };
  }

  async gitSync(app, log) {
    const cwd = this.dir(app);
    await mkdir(cwd, { recursive: true });
    const env = {
      ...baseEnv(),
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    };
    const git = (args, label) => runCommand('git', args, { ...this.taskOptions(app, log, label, env), timeout: 10 * 60 * 1000 });

    // init + fetch + reset fonctionne même si le dossier contient déjà des fichiers (.env, node_modules…)
    if (!existsSync(path.join(cwd, '.git'))) {
      await git(['-c', 'init.defaultBranch=main', 'init', '-q'], 'git init');
      await git(['remote', 'add', 'origin', app.git.url], 'git remote');
    } else {
      await git(['remote', 'set-url', 'origin', app.git.url], 'git remote');
    }
    log.system(`Récupération de ${maskUrl(app.git.url)}${app.git.branch ? ` (branche ${app.git.branch})` : ''}…`);
    const from = log.lines.length;
    try {
      await git(['fetch', '-q', '--depth', '1', 'origin', app.git.branch || 'HEAD'], 'git fetch');
    } catch (err) {
      // cause la plus probable, d'après les messages de git
      const hint = gitHint(stripAnsi(log.lines.slice(from).map((l) => l.m).join('\n')), app);
      if (hint) err.message = `${err.message} : ${hint}`;
      throw err;
    }
    await git(['reset', '-q', '--hard', 'FETCH_HEAD'], 'git reset');
    await git(['log', '-1', '--format=Commit %h : %s (%an, %cr)'], 'git log');
  }

  async install(app, log, explicit) {
    if (!app.installCommand) {
      if (explicit) log.system('Aucune commande d’installation configurée');
      return;
    }
    if (!existsSync(path.join(this.dir(app), 'package.json'))) {
      log.system('Pas de package.json : installation des dépendances ignorée');
      return;
    }
    log.system(`$ ${app.installCommand}`);
    const env = this.appEnv(app, { npm_config_fund: 'false', npm_config_audit: 'false' });
    await runShell(app.installCommand, this.taskOptions(app, log, 'Installation', env));
  }

  async build(app, log, explicit) {
    if (!app.buildCommand) {
      if (explicit) log.system('Aucune commande de build configurée');
      return;
    }
    log.system(`$ ${app.buildCommand}`);
    await runShell(app.buildCommand, this.taskOptions(app, log, 'Build', this.appEnv(app)));
  }

  async importArchive(id, archive, filename, { clean = false } = {}) {
    const app = this.get(id);
    const rt = this.rt(id);
    this.assertIdle(rt);
    const lower = filename.toLowerCase();
    let command;
    let args;
    const out = await mkdtemp(path.join(this.config.tmpDir, 'extract-'));
    if (lower.endsWith('.zip')) {
      command = 'unzip';
      args = ['-q', '-o', archive, '-d', out];
    } else if (/\.(tar|tar\.gz|tgz|tar\.xz|tar\.bz2)$/.test(lower)) {
      command = 'tar';
      args = ['-xf', archive, '-C', out, '--no-same-owner'];
    } else {
      await rm(out, { recursive: true, force: true });
      throw new HttpError(400, 'Format non supporté (.zip, .tar, .tar.gz, .tgz)');
    }

    rt.busy = 'archive';
    const log = this.logsFor(id);
    try {
      log.system(`Extraction de ${filename}…`);
      await runCommand(command, args, { cwd: out, env: baseEnv(), log, label: 'Extraction', timeout: 10 * 60 * 1000 });
      await rm(path.join(out, '__MACOSX'), { recursive: true, force: true });
      // Une archive qui contient un seul dossier (cas des ZIP GitHub) : on prend son contenu.
      let src = out;
      const entries = await readdir(out);
      if (entries.length === 1 && (await stat(path.join(out, entries[0]))).isDirectory()) src = path.join(out, entries[0]);
      const dest = this.dir(app);
      await mkdir(dest, { recursive: true });
      if (clean) {
        for (const name of await readdir(dest)) await rm(path.join(dest, name), { recursive: true, force: true });
      }
      await cp(src, dest, { recursive: true, force: true, verbatimSymlinks: true });
      log.system('✔ Archive importée');
    } catch (err) {
      log.system(`✖ ${err.message}`);
      throw err;
    } finally {
      rt.busy = null;
      await rm(out, { recursive: true, force: true });
      setImmediate(() => this.runQueuedDeploy(id));
    }
  }

  async sampleStats() {
    const running = [...this.runtime.values()].filter((rt) => rt.child?.pid);
    if (!running.length) return;
    const groups = await sampleProcessGroups(new Set(running.map((rt) => rt.child.pid)));
    if (!groups) return;
    const now = Date.now();
    for (const rt of running) {
      const pid = rt.child?.pid;
      const sample = pid && groups.get(pid);
      if (!sample) continue;
      rt.memory = sample.rss;
      if (rt.prevTicks?.pid === pid) {
        const dt = (now - rt.prevTicks.at) / 1000;
        rt.cpu = dt > 0 ? Math.max(0, ((sample.ticks - rt.prevTicks.ticks) / CLK_TCK / dt) * 100) : rt.cpu;
      }
      rt.prevTicks = { pid, ticks: sample.ticks, at: now };
    }
  }

  // Au démarrage du panel : relance les apps qui tournaient avant (en les espaçant un peu).
  /**
   * Lancement des applications au démarrage du panel.
   * - démarrage de la machine : on lance les apps dont l'option « Démarrer avec la machine » est active ;
   * - simple redémarrage du panel (mise à jour…) : on remet chaque app dans l'état où elle était.
   */
  async bootstrap({ systemBoot = false } = {}) {
    for (const app of this.apps) {
      if (this.shuttingDown) return;
      const start = systemBoot ? app.startOnBoot !== false : app.desired === 'running';
      const wanted = start ? 'running' : 'stopped';
      if (app.desired !== wanted) {
        app.desired = wanted;
        this.store.save();
      }
      if (!start) {
        await this.reapStrays(app).catch(() => {});
        continue;
      }
      this.logsFor(app.id).system(systemBoot ? 'Démarrage automatique avec la machine' : 'Démarrage automatique avec le panel');
      await this.launch(app).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    clearInterval(this.statsTimer);
    for (const rt of this.runtime.values()) {
      clearTimeout(rt.restartTimer);
      if (rt.taskChild) killGroup(rt.taskChild.pid, 'SIGTERM');
    }
    await Promise.all(this.apps.filter((app) => this.rt(app.id).child).map((app) => this.terminate(app)));
    for (const log of this.logs.values()) log.close();
  }
}
