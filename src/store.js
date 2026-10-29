import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const DEFAULT_SETTINGS = {
  caddy: {
    // null = détection automatique (activé si le dossier Caddy du panel est accessible en écriture)
    enabled: null,
  },
  panelDomain: '',
  portRange: { start: 4000, end: 4999 },
};

function mergeDefaults(defaults, value) {
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
    return value === undefined ? defaults : value;
  }
  const out = { ...defaults };
  for (const [key, val] of Object.entries(value || {})) {
    out[key] = key in defaults ? mergeDefaults(defaults[key], val) : val;
  }
  return out;
}

// Petite base JSON : tout est en mémoire, écrit de façon atomique à chaque modification.
export class Store {
  constructor(file) {
    this.file = file;
    let data = {};
    if (existsSync(file)) {
      data = JSON.parse(readFileSync(file, 'utf8'));
    }
    this.data = {
      version: 1,
      users: data.users || [],
      apps: data.apps || [],
      settings: mergeDefaults(DEFAULT_SETTINGS, data.settings),
    };
    this.save();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
