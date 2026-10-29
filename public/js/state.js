import { api } from './api.js';

// État partagé : la liste des applications est rafraîchie régulièrement par main.js.
export const state = { user: null, apps: [] };
const listeners = new Set();

export function onAppsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function refreshApps() {
  if (!state.user) return;
  try {
    state.apps = await api.get('/apps');
  } catch {
    return;
  }
  listeners.forEach((fn) => fn(state.apps));
}

export const findApp = (id) => state.apps.find((a) => a.id === id);
