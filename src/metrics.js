import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { currentCpu, memory, temperature } from './system.js';

// Paliers de l'historique : un point par « step », conservé pendant « span ».
export const RANGES = {
  '1h': { step: 10_000, span: 3600_000 },
  '24h': { step: 60_000, span: 86400_000 },
  '15j': { step: 15 * 60_000, span: 15 * 86400_000 },
  '30j': { step: 30 * 60_000, span: 30 * 86400_000 },
};
const SAMPLE_EVERY = 10_000;
const SAVE_EVERY = 10 * 60_000;
const round = (v, d = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Historique CPU / température / RAM. Chaque palier agrège les mesures (moyenne) par intervalle.
 * Un point = [début de l'intervalle (ms), CPU %, température °C, RAM utilisée (Mo)].
 * Sauvegardé sur disque toutes les 10 minutes (pas le palier 1h, pour épargner le disque).
 */
export class Metrics {
  constructor(file) {
    this.file = file;
    this.series = Object.fromEntries(Object.keys(RANGES).map((id) => [id, []]));
    this.pending = {};
    this.memTotal = null;
    this.load();
  }

  load() {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const id of Object.keys(RANGES)) if (Array.isArray(data.series?.[id])) this.series[id] = data.series[id];
      this.memTotal = data.memTotal ?? null;
      this.prune();
    } catch {
      // fichier illisible : on repart d'un historique vide
    }
  }

  save() {
    const { '1h': _skip, ...series } = this.series;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ memTotal: this.memTotal, series }));
    renameSync(tmp, this.file);
  }

  prune(now = Date.now()) {
    for (const [id, { span }] of Object.entries(RANGES)) {
      const series = this.series[id];
      let drop = 0;
      while (drop < series.length && series[drop][0] < now - span) drop++;
      if (drop) series.splice(0, drop);
    }
  }

  add({ cpu, temp, mem }, now = Date.now()) {
    for (const [id, { step }] of Object.entries(RANGES)) {
      const start = Math.floor(now / step) * step;
      let bucket = this.pending[id];
      if (bucket && bucket.t !== start) {
        this.series[id].push(this.close(bucket));
        bucket = null;
      }
      if (!bucket) bucket = this.pending[id] = { t: start, n: 0, cpu: 0, cpuN: 0, temp: 0, tempN: 0, mem: 0, memN: 0 };
      bucket.n++;
      for (const [key, value] of [['cpu', cpu], ['temp', temp], ['mem', mem]]) {
        if (value === null || value === undefined) continue;
        bucket[key] += value;
        bucket[`${key}N`]++;
      }
    }
    this.prune(now);
  }

  close(b) {
    const avg = (sum, n) => (n ? sum / n : null);
    return [b.t, round(avg(b.cpu, b.cpuN)), round(avg(b.temp, b.tempN)), round(avg(b.mem, b.memN), 0)];
  }

  query(range) {
    const def = RANGES[range];
    if (!def) return null;
    const points = [...this.series[range]];
    if (this.pending[range]) points.push(this.close(this.pending[range]));
    return { range, step: def.step, span: def.span, memTotal: this.memTotal, now: Date.now(), points };
  }

  async sample() {
    const [mem, temp] = await Promise.all([memory(), temperature()]);
    this.memTotal = Math.round(mem.total / 1024 / 1024);
    this.add({ cpu: currentCpu(), temp, mem: mem.used / 1024 / 1024 });
  }

  start() {
    this.sampleTimer = setInterval(() => this.sample().catch(() => {}), SAMPLE_EVERY);
    this.saveTimer = setInterval(() => this.trySave(), SAVE_EVERY);
    this.sampleTimer.unref();
    this.saveTimer.unref();
    setTimeout(() => this.sample().catch(() => {}), 2500).unref(); // première mesure CPU disponible après 2 s
  }

  trySave() {
    try {
      this.save();
    } catch (err) {
      console.warn(`Historique des métriques non sauvegardé : ${err.message}`);
    }
  }

  stop() {
    clearInterval(this.sampleTimer);
    clearInterval(this.saveTimer);
    this.trySave();
  }
}
