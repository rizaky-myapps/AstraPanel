import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { currentCpu, memory, temperature } from './system.js';

// Paliers enregistrés : un point par « step », conservé pendant « span ».
export const TIERS = {
  '1h': { step: 10_000, span: 3600_000 },
  '24h': { step: 60_000, span: 86400_000 },
  '3j': { step: 5 * 60_000, span: 3 * 86400_000 },
  '7j': { step: 15 * 60_000, span: 7 * 86400_000 },
};

// Périodes proposées dans les graphiques : chacune lit un palier (12 h = la fin du palier 24 h).
export const RANGES = {
  '1h': { tier: '1h', span: 3600_000 },
  '12h': { tier: '24h', span: 12 * 3600_000 },
  '24h': { tier: '24h', span: 86400_000 },
  '3j': { tier: '3j', span: 3 * 86400_000 },
  '7j': { tier: '7j', span: 7 * 86400_000 },
};
export const RANGE_LIST = Object.keys(RANGES).join(', ');

// Paliers des versions précédentes (1.4.3 et avant), repris au chargement d'un ancien historique
const OLD_STEPS = { '15j': 15 * 60_000, '30j': 30 * 60_000 };

// Regroupe des points [t, v1, v2…] par intervalles de « step » (moyenne de chaque valeur, en ignorant les vides).
export function downsample(points, step) {
  const groups = new Map();
  for (const [t, ...values] of points) {
    const start = Math.floor(t / step) * step;
    let g = groups.get(start);
    if (!g) groups.set(start, (g = values.map(() => [0, 0])));
    values.forEach((v, i) => {
      if (v === null || v === undefined || !g[i]) return;
      g[i][0] += v;
      g[i][1]++;
    });
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, g]) => [t, ...g.map(([sum, n]) => (n ? Math.round((sum / n) * 10) / 10 : null))]);
}

// Complète un historique enregistré ({ palier: points }) avec les paliers qui lui manquent, calculés à partir du
// palier le plus long dont les intervalles tombent juste (ex. 3 j ← 24 h regroupé par 5 min, 7 j ← l'ancien 15 j).
export function fillTiers(saved) {
  const stepOf = (id) => TIERS[id]?.step ?? OLD_STEPS[id];
  const out = {};
  for (const [id, { step }] of Object.entries(TIERS)) {
    if (Array.isArray(saved[id])) {
      out[id] = saved[id];
      continue;
    }
    const sources = Object.entries(saved)
      .filter(([src, points]) => Array.isArray(points) && points.length && stepOf(src) && stepOf(src) <= step && step % stepOf(src) === 0)
      .sort((a, b) => a[1][0][0] - b[1][0][0] || stepOf(a[0]) - stepOf(b[0]));
    if (!sources.length) continue;
    const [src, points] = sources[0];
    out[id] = stepOf(src) === step ? points : downsample(points, step);
  }
  return out;
}
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
    this.series = Object.fromEntries(Object.keys(TIERS).map((id) => [id, []]));
    this.pending = {};
    this.memTotal = null;
    this.load();
  }

  load() {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      Object.assign(this.series, fillTiers(data.series || {}));
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
    for (const [id, { span }] of Object.entries(TIERS)) {
      const series = this.series[id];
      let drop = 0;
      while (drop < series.length && series[drop][0] < now - span) drop++;
      if (drop) series.splice(0, drop);
    }
  }

  add({ cpu, temp, mem }, now = Date.now()) {
    for (const [id, { step }] of Object.entries(TIERS)) {
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
    const now = Date.now();
    const points = this.series[def.tier].filter((p) => p[0] >= now - def.span);
    if (this.pending[def.tier]) points.push(this.close(this.pending[def.tier]));
    return { range, step: TIERS[def.tier].step, span: def.span, memTotal: this.memTotal, now, points };
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
