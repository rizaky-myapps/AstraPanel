import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const DEFAULT_SETTINGS = {
  panelDomain: '',
  portRange: { start: 4000, end: 4999 },
  // Tunnel Cloudflare : « token » = géré depuis le site Cloudflare, « api » = géré depuis le panel
  tunnel: {
    enabled: false,
    mode: 'token',
    token: '',
    api: { apiToken: '', accountId: '', accountName: '', tunnelId: '', tunnelName: '', tunnelToken: '' },
  },
  // Branche GitHub suivie pour les mises à jour (vide = celle de l'installation)
  update: { branch: '' },
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
      // les comptes créés avant l'arrivée des rôles étaient tous administrateurs
      users: (data.users || []).map((u) => ({ role: 'admin', ...u })),
      apps: data.apps || [],
      settings: mergeDefaults(DEFAULT_SETTINGS, data.settings),
      // identifiant du dernier démarrage du système vu par le panel
      state: { bootId: null, ...data.state },
    };
    delete this.data.settings.caddy; // réglage des anciennes versions (Caddy a été retiré)
    this.save();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
