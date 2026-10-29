import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { HttpError } from '../http/util.js';
import { normalizeDomains } from '../caddy.js';
import { LogBuffer } from './logs.js';
import { baseEnv, killGroup, pipeOutput, runCommand, runShell } from './process.js';
import { CLK_TCK, sampleProcessGroups } from './stats.js';

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
  constructor({ store, caddy, config }) {
    this.store = store;
    this.caddy = caddy;
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
      },
    };
  }

  list() {
    return this.apps.map((app) => this.serialize(app));
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
    if ('env' in input) app.env = cleanEnv(input.env);
    if ('git' in input) app.git = cleanGit(input.git);
    if ('domains' in input) {
      const domains = normalizeDomains(input.domains);
      if (domains.length && !needsPort(app.type)) throw new HttpError(400, 'Un bot ne peut pas avoir de domaine');
      this.caddy.assertDomainsFree(domains, app.id);
      app.domains = domains;
    }
    if ('port' in input && needsPort(app.type)) {
      const port = cleanPort(input.port);
      if (port === this.config.port) throw new HttpError(409, 'Ce port est utilisé par le panel');
      const other = port && this.apps.find((a) => a.id !== app.id && a.port === port);
      if (other) throw new HttpError(409, `Le port ${port} est déjà utilisé par « ${other.name} »`);
      app.port = port;
    }
  }

  async create(input) {
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
      git: null,
      desired: 'stopped',
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

    const caddy = app.domains.length ? await this.caddy.apply() : null;
    if (source === 'git' || source === 'template') this.runTask(app.id, 'deploy', { start: Boolean(input.start) });
    return { app: this.serialize(app), caddy };
  }

  async update(id, input) {
    const app = this.get(id);
    const copy = structuredClone(app);
    this.applyFields(copy, input);
    if (needsPort(copy.type) && !copy.port) copy.port = await this.allocatePort(copy.id);
    const routingChanged = JSON.stringify([app.domains, app.port]) !== JSON.stringify([copy.domains, copy.port]);
    Object.assign(app, copy, { updatedAt: Date.now() });
    this.store.save();
    const caddy = routingChanged ? await this.caddy.apply() : null;
    return { app: this.serialize(app), caddy };
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
    return { caddy: app.domains?.length ? await this.caddy.apply() : null };
  }

  appEnv(app, extra = {}) {
    const env = {
      ...baseEnv(),
      npm_config_update_notifier: 'false',
      ...extra,
      ...app.env,
      ASTRA_APP_ID: app.id,
      ASTRA_APP_NAME: app.name,
    };
    if (app.port) env.PORT = String(app.port);
    return env;
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

    if (rt.stopping || this.shuttingDown) {
      rt.stopping = false;
      rt.status = 'stopped';
      log.system(`■ Arrêté (${how})`);
      waiters.forEach((fn) => fn());
      return;
    }

    waiters.forEach((fn) => fn());
    log.system(`✖ Le processus s’est arrêté de façon inattendue (${how})`);
    rt.status = 'crashed';
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
      if (current?.desired === 'running' && !this.shuttingDown) this.spawnApp(current);
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
    this.spawnApp(app);
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
    if (app.desired === 'running' && this.find(id)) this.spawnApp(app);
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

  // Tâches longues (déploiement, npm install, build) : lancées en arrière-plan, sortie dans la console.
  runTask(id, task, { start = false } = {}) {
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
        if (task === 'deploy' && this.find(id) && (start || rt.child || app.desired === 'running')) {
          rt.busy = null;
          await this.restart(id);
        }
      } catch (err) {
        if (this.find(id)) log.system(`✖ ${err.message}`);
      } finally {
        rt.busy = null;
        rt.taskChild = null;
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
    await git(['fetch', '-q', '--depth', '1', 'origin', app.git.branch || 'HEAD'], 'git fetch');
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
  async bootstrap() {
    for (const app of this.apps) {
      if (app.desired !== 'running' || this.shuttingDown) continue;
      this.logsFor(app.id).system('Démarrage automatique avec le panel');
      this.spawnApp(app);
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
