import os from 'node:os';
import path from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { HttpError } from './http/util.js';
import { bootId, systemInfo } from './system.js';

// Unité installée par install.sh : elle lance deploy/reboot.sh en root quand le panel crée data/reboot-request.
const rebootUnit = () => process.env.ASTRA_REBOOT_UNIT || '/etc/systemd/system/astrapanel-reboot.path';

const readText = (file) => readFile(file, 'utf8').then((s) => s.trim(), () => '');

export class Hardware {
  constructor({ config }) {
    this.config = config;
    this.requestFile = path.join(config.dataDir, 'reboot-request');
    // une demande restée d'avant le démarrage du panel n'a plus de sens
    rmSync(this.requestFile, { force: true });
    this.rebootRequest = null; // { at, by } : affiché à tous les comptes jusqu'à l'arrêt de la machine
  }

  // Redémarrage demandé (pour l'écran d'attente de tous les comptes) ; oublié au bout de 15 minutes.
  pendingReboot() {
    const r = this.rebootRequest;
    if (!r || Date.now() - r.at > 15 * 60_000) return null;
    return { at: r.at, by: r.by, host: os.hostname() };
  }

  get rebootAvailable() {
    return existsSync(rebootUnit());
  }

  async info() {
    const [sys, osRelease, maxFreq] = await Promise.all([
      systemInfo(this.config.dataDir),
      readText('/etc/os-release'),
      readText('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq'),
    ]);
    return {
      ...sys,
      os: /^PRETTY_NAME="?([^"\n]*)"?/m.exec(osRelease)?.[1] || `${os.type()} ${os.release()}`,
      kernel: os.release(),
      cpuModel: os.cpus()[0]?.model?.trim() || null,
      cpuMaxMHz: Number(maxFreq) ? Math.round(Number(maxFreq) / 1000) : null,
      bootedAt: Date.now() - os.uptime() * 1000,
      bootId: bootId(),
      reboot: { available: this.rebootAvailable, pending: existsSync(this.requestFile) },
    };
  }

  // Demande le redémarrage au service root « astrapanel-reboot ». La demande porte l'identifiant du démarrage en
  // cours : le service l'ignore si elle date d'un démarrage précédent (jamais de redémarrage en boucle).
  async requestReboot(user) {
    if (!this.rebootAvailable) {
      throw new HttpError(400, 'Le service de redémarrage n’est pas installé : mettez le panel à jour (ou relancez « sudo ./install.sh ») une fois.');
    }
    if (this.pendingReboot() || (await lstat(this.requestFile).catch(() => null))) throw new HttpError(409, 'Un redémarrage est déjà en cours');
    this.rebootRequest = { at: Date.now(), by: user.username };
    // Le redémarrage part quelques secondes plus tard : toutes les pages ouvertes (elles interrogent le panel toutes
    // les 5 s) ont le temps de voir l'annonce et d'afficher l'écran d'attente avant que la machine ne s'arrête.
    const write = () => writeFile(this.requestFile, JSON.stringify({ by: user.username, at: Date.now(), bootId: bootId() }), { mode: 0o644 });
    const delay = Number(process.env.ASTRA_REBOOT_DELAY ?? 8000);
    if (delay > 0) {
      setTimeout(() => write().catch((err) => console.error(`Redémarrage impossible : ${err.message}`)), delay).unref?.();
    } else {
      await write();
    }
    return { ok: true, bootId: bootId(), delay };
  }
}
