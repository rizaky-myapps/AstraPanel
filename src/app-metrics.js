import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { RANGES, TIERS, fillTiers } from './metrics.js';

const SAMPLE_EVERY = 10_000;
const SAVE_EVERY = 10 * 60_000;
const round = (v, d = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Historique par application : processeur (%) et mémoire (Mo), mêmes paliers et périodes que l'historique de la
 * machine (1 h, 12 h, 24 h, 3 j, 7 j). Un point = [début de l'intervalle (ms), CPU %, RAM Mo]. Seules les périodes où
 * l'application tourne sont enregistrées : un arrêt laisse un trou dans les graphiques.
 * Sauvegardé sur disque toutes les 10 minutes (sauf le palier 1 h).
 */
export class AppMetrics {
  constructor(file, apps) {
    this.file = file;
    this.apps = apps;
    this.series = new Map(); // id -> { '1h': [...], ... }
    this.pending = new Map(); // id -> { '1h': bucket, ... }
    this.load();
  }

  seriesFor(id) {
    let s = this.series.get(id);
    if (!s) {
      s = Object.fromEntries(Object.keys(TIERS).map((r) => [r, []]));
      this.series.set(id, s);
    }
    return s;
  }

  load() {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [id, saved] of Object.entries(data.apps || {})) {
        Object.assign(this.seriesFor(id), fillTiers(saved || {}));
      }
      this.prune();
    } catch {
      // fichier illisible : on repart d'un historique vide
    }
  }

  save() {
    const known = new Set(this.apps.apps.map((a) => a.id));
    const out = {};
    for (const [id, s] of this.series) {
      if (!known.has(id)) continue; // application supprimée : son historique part avec elle
      const { '1h': _skip, ...kept } = s;
      out[id] = kept;
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ apps: out }));
    renameSync(tmp, this.file);
  }

  prune(now = Date.now()) {
    for (const s of this.series.values()) {
      for (const [r, { span }] of Object.entries(TIERS)) {
        const points = s[r];
        let drop = 0;
        while (drop < points.length && points[drop][0] < now - span) drop++;
        if (drop) points.splice(0, drop);
      }
    }
  }

  add(id, { cpu, mem }, now = Date.now()) {
    const s = this.seriesFor(id);
    let pending = this.pending.get(id);
    if (!pending) this.pending.set(id, (pending = {}));
    for (const [r, { step }] of Object.entries(TIERS)) {
      const start = Math.floor(now / step) * step;
      let b = pending[r];
      if (b && b.t !== start) {
        s[r].push(this.close(b));
        b = null;
      }
      if (!b) b = pending[r] = { t: start, cpu: 0, cpuN: 0, mem: 0, memN: 0 };
      if (cpu !== null && cpu !== undefined) {
        b.cpu += cpu;
        b.cpuN++;
      }
      if (mem !== null && mem !== undefined) {
        b.mem += mem;
        b.memN++;
      }
    }
  }

  close(b) {
    return [b.t, round(b.cpuN ? b.cpu / b.cpuN : null), round(b.memN ? b.mem / b.memN : null, 1)];
  }

  query(id, range) {
    const def = RANGES[range];
    if (!def) return null;
    const now = Date.now();
    const s = this.series.get(id);
    const points = s ? s[def.tier].filter((p) => p[0] >= now - def.span) : [];
    const b = this.pending.get(id)?.[def.tier];
    if (b) points.push(this.close(b));
    return { range, step: TIERS[def.tier].step, span: def.span, now, points };
  }

  forget(id) {
    this.series.delete(id);
    this.pending.delete(id);
  }

  // Une mesure toutes les 10 s pour chaque application en marche (valeurs calculées par AppManager.sampleStats)
  sample(now = Date.now()) {
    for (const app of this.apps.apps) {
      const rt = this.apps.runtime.get(app.id);
      if (!rt?.child || rt.status !== 'running') continue;
      if (rt.cpu === null && !rt.memory) continue;
      this.add(app.id, { cpu: rt.cpu, mem: rt.memory ? rt.memory / 1024 / 1024 : null }, now);
    }
    this.prune(now);
  }

  start() {
    this.sampleTimer = setInterval(() => this.sample(), SAMPLE_EVERY);
    this.saveTimer = setInterval(() => this.trySave(), SAVE_EVERY);
    this.sampleTimer.unref();
    this.saveTimer.unref();
  }

  trySave() {
    try {
      this.save();
    } catch (err) {
      console.warn(`Historique des applications non sauvegardé : ${err.message}`);
    }
  }

  stop() {
    clearInterval(this.sampleTimer);
    clearInterval(this.saveTimer);
    this.trySave();
  }
}
