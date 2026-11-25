import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// Journal d'activité : qui a fait quoi, quand, sur quoi, depuis quelle adresse.
// Une ligne JSON par action dans data/audit.log. Jamais de secret : ni mot de passe, ni jeton, ni valeur de
// variable d'environnement (seulement leurs noms).

const KEEP = 10_000; // entrées conservées
const ROLE = { admin: 'Administrateur', user: 'Utilisateur' };
const TYPE = { bot: 'bot Discord', node: 'site Node.js', static: 'site statique' };
const TASKS = { deploy: 'Déploiement', install: 'Installation des dépendances', build: 'Build' };
const FIELDS = {
  name: 'nom',
  startCommand: 'commande de démarrage',
  installCommand: 'installation des dépendances',
  buildCommand: 'commande de build',
  staticDir: 'dossier publié',
  spa: 'mode SPA',
  autoRestart: 'redémarrage automatique',
  startOnBoot: 'démarrage avec le Raspberry Pi',
  git: 'dépôt Git',
  port: 'port',
};

const short = (text, max = 160) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const list = (values, max = 4) => {
  const items = (Array.isArray(values) ? values : [values]).filter((v) => v !== undefined && v !== null && v !== '').map(String);
  return items.length > max ? `${items.slice(0, max).join(', ')}… (+${items.length - max})` : items.join(', ');
};
const join = (dir, name) => [dir, name].filter(Boolean).join('/');
const onOff = (v) => (v ? 'activé' : 'désactivé');

function appChanges(body = {}) {
  const parts = [];
  for (const [key, label] of Object.entries(FIELDS)) {
    if (!(key in body)) continue;
    if (key === 'spa' || key === 'autoRestart' || key === 'startOnBoot') parts.push(`${label} ${onOff(body[key])}`);
    else if (key === 'git') parts.push(body.git?.url ? `${label} : ${short(String(body.git.url).replace(/\/\/[^@/]+@/, '//'), 80)}` : `${label} retiré`);
    else parts.push(`${label} : ${short(body[key], 80) || '(vide)'}`);
  }
  if ('domains' in body) parts.push(`domaines : ${list(body.domains) || 'aucun'}`);
  if ('env' in body) parts.push(`variables : ${list(Object.keys(body.env || {}), 8) || 'aucune'}`);
  return parts.join(' · ');
}

// Description de chaque action, par route. c = { params, query, body, result, names }
const ACTIONS = {
  // --- Applications
  'POST /api/apps': (c) => ({ label: 'Création de l’application', detail: c.result?.app ? TYPE[c.result.app.type] : null }),
  'PATCH /api/apps/:id': (c) => ({ label: 'Modification des paramètres', detail: appChanges(c.body) }),
  'DELETE /api/apps/:id': () => ({ label: 'Suppression de l’application' }),
  'POST /api/apps/:id/start': () => ({ label: 'Démarrage' }),
  'POST /api/apps/:id/stop': () => ({ label: 'Arrêt' }),
  'POST /api/apps/:id/restart': () => ({ label: 'Redémarrage' }),
  'POST /api/apps/:id/kill': () => ({ label: 'Arrêt forcé' }),
  'POST /api/apps/:id/tasks/cancel': () => ({ label: 'Annulation de la tâche en cours' }),
  'POST /api/apps/:id/tasks/:task': (c) => ({ label: TASKS[c.params.task] || `Tâche « ${c.params.task} »`, detail: c.body?.start ? 'puis démarrage' : null }),
  'POST /api/apps/:id/stdin': (c) => ({ label: 'Commande envoyée dans la console', detail: short(c.body?.text, 120) }),
  'POST /api/apps/:id/members': (c) => ({ label: 'Accès donné', detail: c.names.member }),
  'DELETE /api/apps/:id/members/:userId': (c) => ({ label: 'Accès retiré', detail: c.names.member }),
  'POST /api/apps/:id/webhook': () => ({ label: 'Nouvelle adresse de webhook' }),
  'POST /api/apps/:id/archive': (c) => ({
    label: 'Import d’une archive',
    detail: list([c.query.get('filename'), c.query.get('clean') === '1' && 'dossier vidé avant', c.query.get('deploy') === '1' && 'puis déploiement'].filter(Boolean)),
  }),
  'DELETE /api/apps/:id/logs': () => ({ label: 'Console effacée' }),
  // --- Fichiers
  'PUT /api/apps/:id/files/content': (c) => ({ label: 'Fichier enregistré', detail: c.body?.path }),
  'POST /api/apps/:id/files/mkdir': (c) => ({ label: 'Dossier créé', detail: c.body?.path }),
  'POST /api/apps/:id/files/rename': (c) => ({ label: 'Renommage', detail: `${c.body?.from} → ${c.body?.to}` }),
  'POST /api/apps/:id/files/move': (c) => ({ label: 'Déplacement', detail: `${list(c.body?.paths)} → /${c.body?.dest || ''}` }),
  'POST /api/apps/:id/files/copy': (c) => ({ label: 'Copie', detail: `${list(c.body?.paths)} → /${c.body?.dest || ''}` }),
  'POST /api/apps/:id/files/delete': (c) => ({ label: 'Suppression de fichiers', detail: list(c.body?.paths) }),
  'DELETE /api/apps/:id/files': (c) => ({ label: 'Suppression de fichiers', detail: c.query.get('path') }),
  'POST /api/apps/:id/files/compress': (c) => ({
    label: 'Compression ZIP',
    detail: `${list((c.body?.names || []).map((n) => join(c.body?.dir, n)))} → ${join(c.body?.dir, c.result?.name)}`,
  }),
  'POST /api/apps/:id/files/extract': (c) => ({ label: 'Extraction d’une archive', detail: c.body?.path }),
  'POST /api/apps/:id/files/upload': (c) => ({ label: 'Fichier téléversé', detail: join(c.query.get('path'), c.query.get('name')) }),
  // --- Comptes
  'POST /api/auth/password': () => ({ label: 'Changement de son mot de passe' }),
  'POST /api/users': (c) => ({ label: 'Création d’un compte', detail: `${c.body?.username} (${ROLE[c.body?.role] || ROLE.user})` }),
  'PATCH /api/users/:id': (c) => ({
    label: 'Modification d’un compte',
    detail: list([c.names.user, c.body?.role && `grade : ${ROLE[c.body.role] || c.body.role}`, c.body?.password && 'nouveau mot de passe défini'].filter(Boolean)),
  }),
  'DELETE /api/users/:id': (c) => ({ label: 'Suppression d’un compte', detail: c.names.user }),
  // --- Panel
  'PATCH /api/settings': (c) => ({
    label: 'Paramètres généraux modifiés',
    detail: list([
      'panelDomain' in (c.body || {}) && `domaine du panel : ${c.body.panelDomain || 'aucun'}`,
      c.body?.portRange && `ports des sites : ${c.body.portRange.start}–${c.body.portRange.end}`,
    ].filter(Boolean)),
  }),
  'POST /api/update/check': () => ({ label: 'Vérification des mises à jour du panel' }),
  'POST /api/update/apply': (c) => ({ label: 'Mise à jour du panel lancée', detail: c.names.version ? `vers la version ${c.names.version}` : null }),
  'POST /api/hardware/reboot': () => ({ label: 'Redémarrage de la machine' }),
  // --- Tunnel Cloudflare
  'POST /api/tunnel/install': (c) => ({ label: 'Installation de cloudflared', detail: c.result?.version ? `version ${c.result.version}` : null }),
  'POST /api/tunnel/check-update': () => ({ label: 'Vérification des mises à jour de cloudflared' }),
  'POST /api/tunnel/token': () => ({ label: 'Jeton du tunnel enregistré' }),
  'POST /api/tunnel/api/connect': () => ({ label: 'Jeton d’API Cloudflare connecté' }),
  'POST /api/tunnel/api/setup': (c) => ({ label: 'Création du tunnel', detail: c.body?.name }),
  'POST /api/tunnel/enabled': (c) => ({ label: c.body?.enabled ? 'Tunnel démarré' : 'Tunnel arrêté' }),
  'POST /api/tunnel/restart': () => ({ label: 'Tunnel redémarré' }),
  'POST /api/tunnel/sync': () => ({ label: 'Synchronisation des domaines' }),
  'POST /api/tunnel/dns/replace': (c) => ({ label: 'Enregistrement DNS remplacé', detail: c.body?.hostname }),
  'POST /api/tunnel/reset': () => ({ label: 'Configuration du tunnel supprimée' }),
};

const CATEGORY = [
  [/^\/api\/apps\/:id\/files/, 'fichiers'],
  [/^\/api\/apps/, 'application'],
  [/^\/api\/(users|auth)/, 'compte'],
  [/^\/api\/tunnel/, 'tunnel'],
  [/^\/api\/hardware/, 'machine'],
  [/^\/api\/(update|settings)/, 'panel'],
];

export class AuditLog {
  constructor({ file, store }) {
    this.file = file;
    this.store = store;
    this.entries = [];
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          this.entries.push(JSON.parse(line));
        } catch {
          // ligne abîmée (arrêt brutal) : ignorée
        }
      }
      this.entries = this.entries.slice(-KEEP);
    }
    this.written = this.entries.length;
  }

  username(id) {
    return this.store.data.users.find((u) => u.id === id)?.username ?? null;
  }

  // Ajoute une entrée. user : compte connecté (ou null), app : { id, name } concerné.
  record({ user = null, ip = null, category, label, detail = null, app = null }) {
    const entry = {
      at: Date.now(),
      user: user ? { id: user.id, username: user.username } : null,
      ip,
      category,
      label,
      detail: detail ? short(detail, 300) : null,
      app: app ? { id: app.id, name: app.name } : null,
    };
    this.entries.push(entry);
    try {
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      this.written += 1;
      // le fichier ne grossit pas indéfiniment : on le réécrit avec les dernières entrées
      if (this.written > KEEP * 1.2) {
        this.entries = this.entries.slice(-KEEP);
        writeFileSync(this.file, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
        this.written = this.entries.length;
      }
    } catch (err) {
      console.error(`Journal d'activité : écriture impossible (${err.message})`);
    }
    if (this.entries.length > KEEP * 1.2) this.entries = this.entries.slice(-KEEP);
    return entry;
  }

  // Avant l'action : ce qui ne sera plus lisible après (nom d'une appli ou d'un compte supprimé…).
  prepare(ctx, route, apps) {
    const key = `${ctx.req.method} ${route.pattern}`;
    if (!ACTIONS[key]) return null;
    const names = {};
    if (ctx.params.userId) names.member = this.username(ctx.params.userId);
    if (route.pattern.startsWith('/api/users/:id')) names.user = this.username(ctx.params.id);
    const app = route.app ? apps.find(ctx.params.id) : null;
    return { key, names, app: app ? { id: app.id, name: app.name } : null, pattern: route.pattern };
  }

  // Après une action réussie.
  done(pre, ctx, result, extra = {}) {
    if (!pre) return;
    const names = { ...pre.names, ...extra };
    if (pre.key === 'POST /api/apps/:id/members') names.member = this.username(ctx.body?.userId);
    const { label, detail } = ACTIONS[pre.key]({ params: ctx.params, query: ctx.query, body: ctx.body, result, names });
    const app = pre.app || (pre.key === 'POST /api/apps' && result?.app ? result.app : null);
    this.record({
      user: ctx.user,
      ip: ctx.ip,
      category: CATEGORY.find(([re]) => re.test(pre.pattern))?.[1] || 'panel',
      label,
      detail,
      app,
    });
  }

  // Entrées les plus récentes d'abord, avec filtres facultatifs.
  query({ userId = '', appId = '', category = '', q = '', before = 0, limit = 100 } = {}) {
    const needle = String(q).toLowerCase().trim();
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length <= limit; i--) {
      const e = this.entries[i];
      if (before && e.at >= before) continue;
      if (userId && (e.user?.id || '') !== (userId === '-' ? '' : userId)) continue;
      if (appId && e.app?.id !== appId) continue;
      if (category && e.category !== category) continue;
      if (needle && ![e.label, e.detail, e.app?.name, e.user?.username, e.ip].some((v) => String(v || '').toLowerCase().includes(needle))) continue;
      out.push(e);
    }
    const more = out.length > limit;
    // comptes et applis présents dans le journal, pour les filtres
    const users = new Map();
    const appsSeen = new Map();
    for (const e of this.entries) {
      if (e.user) users.set(e.user.id, e.user.username);
      if (e.app) appsSeen.set(e.app.id, e.app.name);
    }
    for (const u of this.store.data.users) users.set(u.id, u.username);
    return {
      entries: out.slice(0, limit),
      more,
      users: [...users].map(([id, username]) => ({ id, username })).sort((a, b) => a.username.localeCompare(b.username)),
      apps: [...appsSeen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}
