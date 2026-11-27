import { api } from './api.js';
import { APP_GROUPS, appGroup } from './ui.js';

// État partagé : la liste des applications est rafraîchie régulièrement par main.js.
export const state = { user: null, apps: [], appsLoaded: false, returnTo: '/home' };
const listeners = new Set();

export function onAppsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function refreshApps() {
  if (!state.user) return;
  try {
    state.apps = await api.get('/apps');
    state.appsLoaded = true;
  } catch {
    return;
  }
  listeners.forEach((fn) => fn(state.apps));
}

export const findApp = (id) => state.apps.find((a) => a.id === id);
export const isAdmin = () => state.user?.role === 'admin';

// Applications dans l'ordre d'affichage : par catégorie (bots, sites, serveurs), puis dans l'ordre choisi par
// glisser-déposer (enregistré avec le compte). Une application jamais déplacée garde sa place de création, en fin de catégorie.
export function sortedApps(apps = state.apps) {
  const rank = new Map((state.user?.prefs?.appOrder || []).map((id, i) => [id, i]));
  const groupRank = (app) => {
    const i = APP_GROUPS.indexOf(appGroup(app));
    return i < 0 ? APP_GROUPS.length : i;
  };
  const NONE = Number.MAX_SAFE_INTEGER;
  return apps
    .map((app, i) => ({ app, i }))
    .sort((a, b) => groupRank(a.app) - groupRank(b.app) || (rank.get(a.app.id) ?? NONE) - (rank.get(b.app.id) ?? NONE) || a.i - b.i)
    .map((x) => x.app);
}

// Nouvel ordre (identifiants des applications visibles, dans l'ordre affiché) : appliqué tout de suite, puis enregistré.
// Les applications que ce compte ne voit pas gardent leur place relative dans l'ordre enregistré.
export async function saveAppOrder(ids) {
  if (!state.user) return;
  const previous = state.user.prefs?.appOrder || [];
  const shown = new Set(ids);
  const appOrder = [...ids, ...previous.filter((id) => !shown.has(id))];
  state.user = { ...state.user, prefs: { ...state.user.prefs, appOrder } };
  listeners.forEach((fn) => fn(state.apps));
  try {
    await api.patch('/account/preferences', { appOrder });
  } catch (err) {
    state.user = { ...state.user, prefs: { ...state.user.prefs, appOrder: previous } };
    listeners.forEach((fn) => fn(state.apps));
    throw err;
  }
}
