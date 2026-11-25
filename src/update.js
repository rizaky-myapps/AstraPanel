import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { HttpError } from './http/util.js';
import { baseEnv } from './apps/process.js';
import { stripAnsi } from './apps/logs.js';
import { LATEST_BRANCH, compareVersions, parseVersion } from './version.js';

const execFileAsync = promisify(execFile);
// Le panel regarde la branche « AstraPanel-Latest » toutes les 5 minutes.
export const CHECK_EVERY = 5 * 60_000;

// Fichiers du service de mise à jour (installés par install.sh, écrits par root)
const UPDATER_UNIT = '/etc/systemd/system/astrapanel-update.path';
const statusFile = () => process.env.ASTRA_UPDATE_STATUS || '/var/lib/astrapanel/update-status.json';
const logFile = () => process.env.ASTRA_UPDATE_LOG || '/var/log/astrapanel-update.log';
const RUN_FRESH = 30 * 60_000; // une mise à jour plus ancienne n'est plus « en cours »
const REQUEST_FRESH = 5 * 60_000; // demande jamais prise en charge (service arrêté) : ignorée ensuite

// « https://jeton@github.com/moi/projet.git » ou « git@github.com:moi/projet.git » -> { owner, repo, token }
export function parseGithub(url) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url));
  if (!m) return null;
  const token = /^https:\/\/(?:[^:@/]+:)?([^@/]+)@github\.com/.exec(String(url))?.[1] || null;
  return { owner: m[1], repo: m[2], token };
}

const maskUrl = (url) => String(url || '').replace(/^(https?:\/\/)[^@/]+@/, '$1');

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 60_000,
    env: { ...baseEnv(), GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
  });
  return stdout.trim();
}

async function tail(file, bytes = 64 * 1024) {
  try {
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, bytes);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      return buf.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

export class Updater {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
    this.requestFile = path.join(config.dataDir, 'update-request');
    this.cacheDir = path.join(config.dataDir, 'update-cache');
    this.inflight = null;
    this.nextCheck = null;
    this.state = { lastCheck: null, latestCommit: null, latestVersion: null, commits: [], error: null };
  }

  // Version installée : écrite par install.sh, sinon lue dans le dépôt git (mode développement).
  installed() {
    const file = path.join(this.config.root, 'version.json');
    if (existsSync(file)) {
      try {
        return { ...JSON.parse(readFileSync(file, 'utf8')), source: 'install' };
      } catch {
        return null;
      }
    }
    return null;
  }

  async installedOrGit() {
    const v = this.installed();
    if (v) return v;
    if (!existsSync(path.join(this.config.root, '.git'))) return null;
    try {
      const [repo, commit] = await Promise.all([
        git(['remote', 'get-url', 'origin'], this.config.root),
        git(['rev-parse', 'HEAD'], this.config.root),
      ]);
      return { repo, commit, source: 'git' };
    } catch {
      return null;
    }
  }

  // Lit la version publiée sur AstraPanel-Latest : téléchargement minimal (dernier commit seulement)
  // dans un dépôt temporaire, puis lecture de « version » dans son package.json.
  async readLatest(repo) {
    const dir = this.cacheDir;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    try {
      await git(['init', '--bare', '--quiet', dir]);
      await git(['--git-dir', dir, 'fetch', '--quiet', '--depth=1', '--no-tags', repo, `+refs/heads/${LATEST_BRANCH}:refs/heads/latest`]);
      const commit = await git(['--git-dir', dir, 'rev-parse', 'refs/heads/latest']);
      let version = null;
      try {
        version = JSON.parse(await git(['--git-dir', dir, 'show', 'refs/heads/latest:package.json'])).version;
      } catch {
        // package.json absent ou illisible : traité ci-dessous
      }
      if (!parseVersion(version)) throw new Error(`version illisible dans le package.json de « ${LATEST_BRANCH} »`);
      return { commit, version };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Compare la version installée à celle de la branche AstraPanel-Latest.
  // Une seule vérification à la fois : les appels simultanés partagent la même.
  check() {
    this.inflight ||= this.doCheck()
      .finally(() => {
        this.inflight = null;
      })
      .then(() => this.status());
    return this.inflight;
  }

  async doCheck() {
    const installed = await this.installedOrGit();
    if (!installed?.repo || String(installed.repo).startsWith('-')) {
      this.state.error = 'Installation non reliée à un dépôt Git : réinstallez avec install.sh depuis un clone.';
      return;
    }
    try {
      // 1. dernier commit de la branche (quelques octets) ; 2. sa version, seulement s'il a changé
      const ref = `refs/heads/${LATEST_BRANCH}`;
      const line = (await git(['ls-remote', installed.repo, ref])).split('\n').find((l) => l.split('\t')[1] === ref);
      if (!line) throw new Error(`la branche « ${LATEST_BRANCH} » n’existe pas sur le dépôt`);
      const sha = line.split('\t')[0];
      if (sha !== this.state.latestCommit || !this.state.latestVersion) {
        const latest = await this.readLatest(installed.repo);
        const newer = compareVersions(latest.version, this.config.version) > 0;
        Object.assign(this.state, {
          latestCommit: latest.commit,
          latestVersion: latest.version,
          commits: newer && latest.commit !== installed.commit ? await this.commitsBetween(installed, latest.commit) : [],
        });
      }
      this.state.error = null;
    } catch (err) {
      const lines = (err.stderr || err.message).toString().trim().split('\n');
      this.state.error = `Vérification impossible : ${lines.find((l) => l.startsWith('fatal:')) || lines.pop()}`;
    } finally {
      this.state.lastCheck = Date.now();
    }
  }

  // Liste des commits à venir via l'API GitHub (facultatif : la mise à jour fonctionne sans).
  async commitsBetween(installed, latest) {
    const gh = parseGithub(installed.repo);
    if (!gh) return [];
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'AstraPanel' };
    if (gh.token) headers.Authorization = `Bearer ${gh.token}`;
    try {
      const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/compare/${installed.commit}...${latest}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.commits || [])
        .slice(-30)
        .reverse()
        .map((c) => ({
          sha: c.sha,
          message: String(c.commit?.message || '').split('\n')[0],
          author: c.commit?.author?.name || '',
          date: c.commit?.author?.date || null,
        }));
    } catch {
      return [];
    }
  }

  async runStatus() {
    try {
      return JSON.parse(await readFile(statusFile(), 'utf8'));
    } catch {
      return null;
    }
  }

  async status() {
    const installed = await this.installedOrGit();
    const run = await this.runStatus();
    const { latestVersion } = this.state;
    return {
      installed: installed
        ? {
            repo: maskUrl(installed.repo),
            commit: installed.commit,
            version: this.config.version,
            installedAt: installed.installedAt || null,
            source: installed.source,
          }
        : null,
      branch: LATEST_BRANCH,
      latestVersion,
      latestCommit: this.state.latestCommit,
      available: Boolean(installed && latestVersion && compareVersions(latestVersion, this.config.version) > 0),
      commits: this.state.commits,
      checking: Boolean(this.inflight),
      lastCheck: this.state.lastCheck,
      nextCheck: this.nextCheck,
      interval: CHECK_EVERY,
      error: this.state.error,
      updater: existsSync(UPDATER_UNIT),
      pending: existsSync(this.requestFile),
      run,
    };
  }

  async log() {
    return stripAnsi(await tail(logFile()));
  }

  // Progression d'une mise à jour, pour l'écran d'attente affiché à tous les comptes connectés :
  // étape annoncée par update.sh et dernière ligne « ==> » de son journal (rien d'autre du journal).
  async progress() {
    const run = await this.runStatus();
    const requested = await lstat(this.requestFile).catch(() => null);
    const pending = Boolean(requested && Date.now() - requested.mtimeMs < REQUEST_FRESH);
    const fresh = Boolean(run && Date.now() - run.at < RUN_FRESH);
    const active = pending || (fresh && run.state === 'running');
    let step = null;
    if (fresh) {
      const lines = stripAnsi(await tail(logFile(), 16 * 1024)).split('\n');
      step = lines.reverse().find((l) => l.startsWith('==> '))?.slice(4).trim() || null;
    }
    return {
      active,
      pending,
      state: fresh ? run.state : null,
      message: fresh ? run.message : null,
      at: fresh ? run.at : null,
      step,
      target: (fresh && run.version) || this.state.latestVersion || null,
      current: this.config.version,
    };
  }

  // Demande la mise à jour au service root « astrapanel-update » (déclenché par la présence du fichier).
  async request(user) {
    if (!existsSync(UPDATER_UNIT)) {
      throw new HttpError(400, 'Le service de mise à jour n’est pas installé : relancez « sudo ./install.sh » une fois sur le Pi.');
    }
    const run = await this.runStatus();
    if (run?.state === 'running' && Date.now() - run.at < RUN_FRESH) throw new HttpError(409, 'Une mise à jour est déjà en cours');
    const existing = await lstat(this.requestFile).catch(() => null);
    if (existing) throw new HttpError(409, 'Une mise à jour est déjà demandée');
    // le service root installe toujours AstraPanel-Latest : ce fichier sert seulement de déclencheur
    const request = { branch: LATEST_BRANCH, version: this.state.latestVersion, by: user.username, at: Date.now() };
    await writeFile(this.requestFile, JSON.stringify(request), { mode: 0o644 });
    return { ok: true };
  }

  // Première vérification peu après le démarrage, puis toutes les 5 minutes.
  start() {
    const tick = () => {
      this.nextCheck = Date.now() + CHECK_EVERY;
      this.check().catch(() => {});
    };
    this.nextCheck = Date.now() + 15_000;
    this.firstTimer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, CHECK_EVERY);
      this.timer.unref();
    }, 15_000);
    this.firstTimer.unref();
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }
}
