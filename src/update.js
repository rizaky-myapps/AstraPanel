import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, open, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { HttpError } from './http/util.js';
import { baseEnv } from './apps/process.js';
import { stripAnsi } from './apps/logs.js';

const execFileAsync = promisify(execFile);
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
// Chaque version est publiée sur « AstraPanel-version.X.Y.Z-latest » ; l'ancienne perd le suffixe « -latest ».
const VERSION_BRANCH_RE = /^AstraPanel-version\.(\d+)\.(\d+)\.(\d+)(-latest)?$/;

export function parseVersionBranch(name) {
  const m = VERSION_BRANCH_RE.exec(String(name));
  return m ? { version: `${m[1]}.${m[2]}.${m[3]}`, parts: [Number(m[1]), Number(m[2]), Number(m[3])], latest: Boolean(m[4]) } : null;
}

// Tri des branches de version, de la plus récente à la plus ancienne.
function compareVersionBranches(a, b) {
  const [x, y] = [parseVersionBranch(a), parseVersionBranch(b)];
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return y.parts[i] - x.parts[i];
  return Number(y.latest) - Number(x.latest);
}

// Branche la plus récente : celle marquée « -latest » (la plus haute s'il y en a plusieurs), sinon la plus haute version.
export function pickLatestBranch(names) {
  const versions = names.filter((n) => parseVersionBranch(n)).sort(compareVersionBranches);
  return versions.find((n) => parseVersionBranch(n).latest) || versions[0] || null;
}
const CHECK_EVERY = 6 * 3600_000;

// Fichiers du service de mise à jour (installés par install.sh, écrits par root)
const UPDATER_UNIT = '/etc/systemd/system/astrapanel-update.path';
const STATUS_FILE = process.env.ASTRA_UPDATE_STATUS || '/var/lib/astrapanel/update-status.json';
const LOG_FILE = process.env.ASTRA_UPDATE_LOG || '/var/log/astrapanel-update.log';

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
    this.state = { checking: false, lastCheck: null, latest: null, latestBranch: null, commits: [], branches: [], error: null };
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
      const [repo, branch, commit] = await Promise.all([
        git(['remote', 'get-url', 'origin'], this.config.root),
        git(['rev-parse', '--abbrev-ref', 'HEAD'], this.config.root),
        git(['rev-parse', 'HEAD'], this.config.root),
      ]);
      return { repo, branch, commit, source: 'git' };
    } catch {
      return null;
    }
  }

  // Réglage : '' = automatique (dernière version publiée), sinon une branche précise.
  get branchSetting() {
    return this.store.data.settings.update.branch || '';
  }

  // Branche réellement suivie, résolue à partir de la liste des branches du dépôt.
  async branch(names = this.state.branches) {
    if (this.branchSetting) return this.branchSetting;
    return pickLatestBranch(names) || (await this.installedOrGit())?.branch || 'main';
  }

  setBranch(branch) {
    const b = String(branch || '').trim();
    if (b && (!BRANCH_RE.test(b) || b.startsWith('-') || b.includes('..'))) throw new HttpError(400, 'Nom de branche invalide');
    this.store.data.settings.update.branch = b;
    this.store.save();
  }

  // Compare le commit installé au dernier commit de la branche suivie sur GitHub.
  async check() {
    if (this.state.checking) return this.status();
    const installed = await this.installedOrGit();
    if (!installed?.repo) {
      this.state.error = 'Installation non reliée à un dépôt Git : réinstallez avec install.sh depuis un clone.';
      return this.status();
    }
    this.state.checking = true;
    try {
      const heads = await git(['ls-remote', '--heads', installed.repo]);
      const branches = heads
        .split('\n')
        .map((l) => l.split('\t'))
        .filter((p) => p[1]?.startsWith('refs/heads/'))
        .map(([sha, ref]) => ({ name: ref.slice('refs/heads/'.length), sha }));
      const branch = await this.branch(branches.map((b) => b.name));
      const head = branches.find((b) => b.name === branch);
      if (!head) throw new Error(`la branche « ${branch} » n’existe pas sur le dépôt`);
      // versions d'abord (de la plus récente à la plus ancienne), puis les autres branches
      const names = branches.map((b) => b.name);
      const versions = names.filter((n) => parseVersionBranch(n)).sort(compareVersionBranches);
      Object.assign(this.state, {
        latest: head.sha,
        latestBranch: branch,
        branches: [...versions, ...names.filter((n) => !parseVersionBranch(n)).sort()],
        commits: [],
        error: null,
      });
      if (head.sha !== installed.commit) this.state.commits = await this.commitsBetween(installed, head.sha);
    } catch (err) {
      const lines = (err.stderr || err.message).toString().trim().split('\n');
      this.state.error = `Vérification impossible : ${lines.find((l) => l.startsWith('fatal:')) || lines.pop()}`;
    } finally {
      this.state.checking = false;
      this.state.lastCheck = Date.now();
    }
    return this.status();
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
      return JSON.parse(await readFile(STATUS_FILE, 'utf8'));
    } catch {
      return null;
    }
  }

  async status() {
    const installed = await this.installedOrGit();
    const branch = await this.branch();
    const run = await this.runStatus();
    const sameBranch = this.state.latestBranch === branch;
    return {
      installed: installed
        ? {
            repo: maskUrl(installed.repo),
            branch: installed.branch,
            commit: installed.commit,
            version: this.config.version,
            installedAt: installed.installedAt || null,
            source: installed.source,
          }
        : null,
      auto: !this.branchSetting,
      branch,
      latestVersion: parseVersionBranch(branch)?.version || null,
      branches: this.state.branches,
      latest: sameBranch ? this.state.latest : null,
      available: Boolean(installed && sameBranch && this.state.latest && this.state.latest !== installed.commit),
      commits: sameBranch ? this.state.commits : [],
      checking: this.state.checking,
      lastCheck: this.state.lastCheck,
      error: this.state.error,
      updater: existsSync(UPDATER_UNIT),
      pending: existsSync(this.requestFile),
      run,
    };
  }

  async log() {
    return stripAnsi(await tail(LOG_FILE));
  }

  // Demande la mise à jour au service root « astrapanel-update » (déclenché par la présence du fichier).
  async request(user) {
    if (!existsSync(UPDATER_UNIT)) {
      throw new HttpError(400, 'Le service de mise à jour n’est pas installé : relancez « sudo ./install.sh » une fois sur le Pi.');
    }
    const run = await this.runStatus();
    if (run?.state === 'running' && Date.now() - run.at < 30 * 60_000) throw new HttpError(409, 'Une mise à jour est déjà en cours');
    const existing = await lstat(this.requestFile).catch(() => null);
    if (existing) throw new HttpError(409, 'Une mise à jour est déjà demandée');
    if (!this.state.latestBranch) await this.check(); // résout la branche de la dernière version
    await writeFile(this.requestFile, JSON.stringify({ branch: await this.branch(), by: user.username, at: Date.now() }), { mode: 0o644 });
    return { ok: true };
  }

  start() {
    const tick = () => this.check().catch(() => {});
    this.firstTimer = setTimeout(tick, 20_000);
    this.timer = setInterval(tick, CHECK_EVERY);
    this.firstTimer.unref();
    this.timer.unref();
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }
}
