import { isAdmin } from './state.js';
import { html } from './ui.js';
import { elapsedHint, openOverlay, stepsAt } from './overlay.js';

// Écrans d'attente globaux, affichés à tous les comptes connectés, sur n'importe quelle page :
// - mise à jour du panel en cours (lancée ici, par un autre administrateur, ou en SSH avec sudo astrapanel-update) ;
// - redémarrage de la machine demandé depuis Paramètres → Hardware.
// Le serveur est interrogé régulièrement (/api/update/progress) ; tant qu'il ne répond pas, il redémarre.

// Version de la page (écrite par le serveur dans index.html)
const PAGE_VERSION = document.querySelector('meta[name="astra-version"]')?.content || '';
const CLEARED_KEY = 'astra.cache-cleared-for';

// Vide le cache du navigateur puis recharge : le serveur envoie « Clear-Site-Data » (pris en compte en HTTPS) et
// la liste des fichiers de l'interface, que l'on retélécharge en ignorant le cache (efficace aussi en HTTP).
export async function clearCacheAndReload() {
  try {
    const res = await fetch('/api/cache/clear', { method: 'POST', headers: { 'X-Astra': '1' }, cache: 'no-store' });
    const { assets = [] } = res.ok ? await res.json() : {};
    if (window.caches) for (const key of await caches.keys()) await caches.delete(key);
    await Promise.all(assets.map((url) => fetch(url, { cache: 'reload', credentials: 'same-origin' }).catch(() => {})));
  } catch {
    // le rechargement suffit souvent ; on recharge quoi qu'il arrive
  }
  location.reload();
}

const IDLE_POLL = 5000;
const ACTIVE_POLL = 1500;

let timer = null;
let current = null; // écran en cours : { kind: 'update' | 'reboot', screen, …état }

// ---- Mise à jour -------------------------------------------------------------------------------
const UPDATE_STEPS = ['Demande envoyée', 'Téléchargement de la nouvelle version', 'Installation', 'Redémarrage du panel', 'Terminé'];
const UPDATE_GIVE_UP = 20 * 60_000;

// Étape (index dans UPDATE_STEPS) et avancement d'après l'état écrit par le service de mise à jour.
function updatePhase(p, reachable) {
  if (!reachable) return { index: 3, percent: 88 };
  if (p.state === 'done') return { index: 4, percent: 100, done: true };
  if (p.state === 'failed') return { index: -1, percent: 100, failed: true };
  if (p.state !== 'running') return { index: 0, percent: 6 }; // demandée, pas encore prise en charge
  if (/^Téléchargement/.test(p.message || '')) return { index: 1, percent: 22 };
  const step = p.step || '';
  if (/^Démarrage du panel/.test(step)) return { index: 3, percent: 86 };
  if (/^Installation du service/.test(step)) return { index: 2, percent: 78 };
  if (/^(Copie du panel|Retrait)/.test(step)) return { index: 2, percent: 66 };
  if (/^(Node\.js|Installation de Node|Création de l)/.test(step)) return { index: 2, percent: 52 };
  return { index: 2, percent: 40 };
}

function renderUpdate() {
  const u = current;
  const { phase } = u;
  const failed = Boolean(phase.failed || u.finished === 'timeout');
  const done = Boolean(phase.done);
  const detail = failed
    ? u.message || 'La mise à jour a échoué.'
    : !u.reachable
      ? 'Le panel redémarre avec la nouvelle version : il est indisponible quelques secondes.'
      : phase.index === 0
        ? 'En attente du service de mise à jour du Raspberry Pi…'
        : done
          ? 'Mise à jour terminée : rechargement de la page…'
          : u.step || u.message || 'Mise à jour en cours…';
  u.screen.render({
    status: failed ? 'failed' : done ? 'done' : 'busy',
    title: failed ? 'La mise à jour a échoué' : done ? 'AstraPanel est à jour' : 'Mise à jour d’AstraPanel en cours',
    subtitle: u.target ? (u.current && u.current !== u.target ? html`Version ${u.current} → <b>${u.target}</b>` : html`Version <b>${u.target}</b>`) : 'Nouvelle version',
    percent: phase.percent,
    detail,
    steps: stepsAt(UPDATE_STEPS, failed ? u.lastIndex : phase.index, { done, failed }),
    hint: done ? '' : elapsedHint(u.screen, 'La mise à jour continue sur le Raspberry Pi même si vous fermez cette page.'),
    actions: failed
      ? [
          ...(isAdmin() ? [{ label: 'Voir le journal', icon: 'terminal', href: '#/settings/mises-a-jour', onClick: closeCurrent }] : []),
          { label: 'Fermer', primary: true, onClick: closeCurrent },
        ]
      : [],
  });
}

function applyUpdate(p, reachable) {
  const u = current;
  u.reachable = reachable;
  if (reachable) {
    u.step = p.step;
    u.message = p.message;
    u.target = p.target || u.target;
    u.current ||= p.current;
    // un état « terminé » ou « échoué » antérieur à cet écran ne compte pas
    if ((p.state === 'done' || p.state === 'failed') && p.at && p.at < u.screen.startedAt - 10_000) p = { ...p, state: null };
  }
  u.phase = updatePhase(p, reachable);
  if (u.phase.index >= 0) u.lastIndex = u.phase.index;
  if (u.phase.done && !u.finished) {
    u.finished = 'done';
    setTimeout(clearCacheAndReload, 1500);
  }
  if (u.phase.failed) u.finished = 'failed';
  if (!u.finished && Date.now() - u.screen.startedAt > UPDATE_GIVE_UP) {
    u.finished = 'timeout';
    u.message = isAdmin()
      ? 'La mise à jour prend plus de 20 minutes : consultez son journal (Paramètres → Mises à jour).'
      : 'La mise à jour prend plus de 20 minutes : prévenez un administrateur.';
  }
  renderUpdate();
}

// Ouvre l'écran (appelé juste après « Mettre à jour », ou quand le panel détecte une mise à jour en cours).
export function openUpdateOverlay({ target = null, current: version = null, progress = null } = {}) {
  if (current?.kind !== 'update') {
    current?.screen.close();
    current = { kind: 'update', screen: openOverlay('Mise à jour en cours'), target, current: version, reachable: true, phase: { index: 0, percent: 6 }, lastIndex: 0 };
  }
  if (target) current.target = target;
  if (version) current.current = version;
  if (progress) applyUpdate(progress, true);
  else renderUpdate();
  schedule(ACTIVE_POLL);
}

// ---- Redémarrage de la machine ------------------------------------------------------------------
const REBOOT_STEPS = ['Demande envoyée', 'Arrêt de la machine', 'Redémarrage du Raspberry Pi', 'Panel de nouveau en ligne'];
const REBOOT_NOT_STARTED = 90_000;
const REBOOT_GIVE_UP = 10 * 60_000;

function renderReboot() {
  const r = current;
  const age = Date.now() - r.screen.startedAt;
  let index;
  let percent;
  let detail;
  if (r.finished === 'done') {
    [index, percent, detail] = [3, 100, 'La machine a redémarré : rechargement de la page…'];
  } else if (r.finished) {
    [index, percent, detail] = [r.wentDown ? 2 : 1, 100, r.message];
  } else if (r.wentDown) {
    [index, percent, detail] = [2, Math.min(90, 45 + age / 3000), 'Le Raspberry Pi redémarre : le panel, vos sites et vos bots sont indisponibles une à deux minutes.'];
  } else if (age < 3000) {
    [index, percent, detail] = [0, 8, 'Demande envoyée : la machine va redémarrer dans quelques secondes…'];
  } else {
    [index, percent, detail] = [1, 25, 'Arrêt des applications et du système…'];
  }
  const failed = r.finished && r.finished !== 'done';
  r.screen.render({
    status: failed ? 'failed' : r.finished === 'done' ? 'done' : 'busy',
    title: failed ? 'Le redémarrage n’a pas abouti' : r.finished === 'done' ? 'La machine a redémarré' : 'Redémarrage de la machine',
    subtitle: r.host || '',
    percent,
    detail,
    steps: stepsAt(REBOOT_STEPS, index, { done: r.finished === 'done', failed }),
    hint: r.finished ? '' : elapsedHint(r.screen, 'Vos applications repartent toutes seules après le redémarrage.'),
    actions: failed ? [{ label: 'Fermer', primary: true, onClick: closeCurrent }] : [],
  });
}

function applyReboot(p, reachable) {
  const r = current;
  if (r.finished) return;
  const age = Date.now() - r.screen.startedAt;
  if (!reachable) r.wentDown = true;
  // de nouveau joignable après une coupure, ou nouveau démarrage du système : c'est fini
  else if (r.wentDown || (p.bootId && r.bootId && p.bootId !== r.bootId)) r.finished = 'done';
  if (!r.finished && !r.wentDown && age > REBOOT_NOT_STARTED) {
    r.finished = 'not-started';
    r.message = isAdmin()
      ? 'La machine n’a pas commencé à redémarrer. Sur le Raspberry Pi, vérifiez que le service est actif : systemctl status astrapanel-reboot.path'
      : 'La machine n’a pas commencé à redémarrer : prévenez un administrateur.';
  }
  if (!r.finished && age > REBOOT_GIVE_UP) {
    r.finished = 'timeout';
    r.message = 'Le panel ne répond toujours pas après 10 minutes : vérifiez que le Raspberry Pi est bien allumé et branché au réseau.';
  }
  renderReboot();
  if (r.finished === 'done') setTimeout(() => location.reload(), 1500);
}

// Ouvre l'écran de redémarrage (juste après la demande, ou quand le panel signale un redémarrage en cours).
export function openRebootOverlay({ bootId = null, host = '' } = {}) {
  if (current?.kind === 'reboot') return;
  current?.screen.close();
  current = { kind: 'reboot', screen: openOverlay('Redémarrage de la machine'), bootId, host, wentDown: false, finished: null };
  renderReboot();
  schedule(ACTIVE_POLL);
}

// ---- Surveillance ------------------------------------------------------------------------------
function closeCurrent() {
  current?.screen.close();
  current = null;
  schedule(IDLE_POLL);
}

async function poll() {
  let progress = null;
  let reachable = true;
  try {
    const res = await fetch('/api/update/progress', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (res.ok) progress = await res.json();
    else reachable = res.status !== 502 && res.status !== 503;
  } catch {
    reachable = false; // le panel (ou la machine) redémarre
  }
  if (current) {
    const ok = reachable && Boolean(progress);
    if (current.kind === 'update' && !current.finished) applyUpdate(progress || {}, ok);
    else if (current.kind === 'reboot') applyReboot(progress || {}, ok);
    if (current && !current.finished) schedule(ACTIVE_POLL);
    return;
  }
  if (progress?.active) {
    openUpdateOverlay({ progress });
    return;
  }
  if (progress?.reboot) {
    openRebootOverlay({ bootId: progress.bootId, host: progress.reboot.host });
    return;
  }
  // le panel a changé de version (mise à jour faite pendant que la page était ouverte, ou en SSH) : on vide le cache
  // et on recharge, une seule fois par version
  if (progress?.current && PAGE_VERSION && !PAGE_VERSION.startsWith('__') && progress.current !== PAGE_VERSION) {
    let already = null;
    try {
      already = sessionStorage.getItem(CLEARED_KEY);
    } catch {
      // stockage indisponible
    }
    if (already !== progress.current) {
      try {
        sessionStorage.setItem(CLEARED_KEY, progress.current);
      } catch {
        // stockage indisponible
      }
      clearCacheAndReload();
      return;
    }
  }
  schedule(IDLE_POLL);
}

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(poll, delay);
}

export function startUpdateWatch() {
  schedule(0);
}

export function stopUpdateWatch() {
  clearTimeout(timer);
  current?.screen.close();
  current = null;
}
