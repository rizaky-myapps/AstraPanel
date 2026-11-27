import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const DEFAULT_SETTINGS = {
  panelDomain: '',
  // installer tout seul chaque nouvelle version publiée sur AstraPanel-Latest
  autoUpdate: false,
  portRange: { start: 4000, end: 4999 },
  // Tunnel Cloudflare : « token » = géré depuis le site Cloudflare, « api » = géré depuis le panel
  tunnel: {
    enabled: false,
    mode: 'token',
    token: '',
    api: { apiToken: '', accountId: '', accountName: '', tunnelId: '', tunnelName: '', tunnelToken: '' },
  },
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
    // les comptes créés avant l'arrivée des rôles étaient tous administrateurs
    const users = (data.users || []).map((u) => ({ role: 'admin', ...u }));
    // applis créées avant la gestion des accès : attribuées au premier administrateur
    const firstAdmin = users.find((u) => u.role === 'admin')?.id ?? null;
    this.data = {
      version: 1,
      users,
      apps: (data.apps || []).map((a) => ({
        ...a,
        ownerId: a.ownerId === undefined ? firstAdmin : a.ownerId,
        members: Array.isArray(a.members) ? a.members : [],
      })),
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
