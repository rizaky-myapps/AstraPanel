import path from 'node:path';
import { execFile } from 'node:child_process';
import { access, constants, rename, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { HttpError } from './http/util.js';

const execFileAsync = promisify(execFile);
const DOMAIN_RE = /^(https?:\/\/)?(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

// Les domaines finissent dans le Caddyfile : validation stricte pour éviter toute injection de configuration.
export function normalizeDomains(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const out = [];
  for (const raw of list) {
    const domain = String(raw).trim().toLowerCase().replace(/\/+$/, '');
    if (!domain) continue;
    if (domain.length > 253 || !DOMAIN_RE.test(domain)) throw new HttpError(400, `Domaine invalide : ${domain}`);
    if (!out.includes(domain)) out.push(domain);
  }
  if (out.length > 20) throw new HttpError(400, '20 domaines maximum par application');
  return out;
}

export class Caddy {
  constructor({ store, dir, mainConfig, panelPort }) {
    this.store = store;
    this.dir = dir;
    this.file = path.join(dir, 'sites.caddy');
    this.mainConfig = mainConfig;
    this.panelPort = panelPort;
    this.lastError = null;
    this.lastAppliedAt = null;
    this.queue = Promise.resolve();
  }

  async dirWritable() {
    try {
      await access(this.dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  async enabled() {
    const setting = this.store.data.settings.caddy.enabled;
    if (setting === null || setting === undefined) return this.dirWritable();
    return setting;
  }

  async version() {
    try {
      const { stdout } = await execFileAsync('caddy', ['version'], { timeout: 5000 });
      return stdout.trim().split(' ')[0];
    } catch {
      return null;
    }
  }

  generate() {
    const { apps, settings } = this.store.data;
    const blocks = ['# Fichier généré automatiquement par AstraPanel : ne pas modifier à la main.', ''];
    if (settings.panelDomain) {
      blocks.push(`# Panel AstraPanel`, `${settings.panelDomain} {`, '\tencode zstd gzip', `\treverse_proxy 127.0.0.1:${this.panelPort}`, '}', '');
    }
    for (const app of apps) {
      if (!app.port || !app.domains?.length) continue;
      blocks.push(
        `# ${app.name.replace(/[\r\n]/g, ' ')} (${app.id})`,
        `${app.domains.join(', ')} {`,
        '\tencode zstd gzip',
        `\treverse_proxy 127.0.0.1:${app.port}`,
        '}',
        '',
      );
    }
    return blocks.join('\n');
  }

  // Domaines déjà utilisés par une autre app ou par le panel.
  assertDomainsFree(domains, exceptAppId = null) {
    const { apps, settings } = this.store.data;
    for (const domain of domains) {
      if (settings.panelDomain && normalizeDomains(settings.panelDomain).includes(domain)) {
        throw new HttpError(409, `Le domaine ${domain} est déjà utilisé par le panel`);
      }
      const other = apps.find((a) => a.id !== exceptAppId && a.domains?.includes(domain));
      if (other) throw new HttpError(409, `Le domaine ${domain} est déjà utilisé par « ${other.name} »`);
    }
  }

  // Écrit la configuration et demande à Caddy de la recharger (les appels sont sérialisés).
  apply() {
    const run = async () => {
      if (!(await this.enabled())) return { ok: true, skipped: true };
      try {
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, this.generate(), { mode: 0o644 });
        await rename(tmp, this.file);
        await execFileAsync('caddy', ['reload', '--config', this.mainConfig, '--adapter', 'caddyfile'], {
          timeout: 60000,
        });
        this.lastError = null;
        this.lastAppliedAt = Date.now();
        return { ok: true };
      } catch (err) {
        // la sortie de Caddy mélange des logs JSON et le message d'erreur en clair : on garde ce dernier
        const output = (err.stderr || err.message || '').toString().trim();
        const detail = output.split('\n').filter((l) => !l.trim().startsWith('{')).join(' ').slice(-800) || output;
        const missing = err.code === 'ENOENT' && String(err.syscall).startsWith('spawn');
        this.lastError = missing ? 'Caddy n’est pas installé (commande « caddy » introuvable)' : detail;
        return { ok: false, error: this.lastError };
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async status() {
    return {
      enabled: await this.enabled(),
      setting: this.store.data.settings.caddy.enabled,
      version: await this.version(),
      dir: this.dir,
      dirWritable: await this.dirWritable(),
      mainConfig: this.mainConfig,
      lastError: this.lastError,
      lastAppliedAt: this.lastAppliedAt,
      preview: this.generate(),
    };
  }
}
