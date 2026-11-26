import { $, html, icon, setHTML } from './ui.js';
import { isAdmin } from './state.js';

// Écran « mise à jour en cours » : tout le panel est flouté, avec au centre un chargement, les étapes et le détail
// de ce que fait la mise à jour. Il s'affiche pour tous les comptes connectés, sur n'importe quelle page, dès qu'une
// mise à jour est en cours (lancée ici, par un autre administrateur, ou en SSH avec sudo astrapanel-update).

const STEPS = [
  { id: 'request', label: 'Demande envoyée' },
  { id: 'download', label: 'Téléchargement de la nouvelle version' },
  { id: 'install', label: 'Installation' },
  { id: 'restart', label: 'Redémarrage du panel' },
  { id: 'done', label: 'Terminé' },
];
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
const GIVE_UP = 20 * 60_000;

let timer = null;
let overlay = null; // { el, startedAt, target, phase, step, reachable, sawRestart, finished }

// Étape et avancement (en %) d'après l'état écrit par le service de mise à jour et sa dernière ligne de journal.
function phaseOf(p, reachable) {
  if (!reachable) return { id: 'restart', percent: 88 };
  if (p.state === 'done') return { id: 'done', percent: 100 };
  if (p.state === 'failed') return { id: 'failed', percent: 100 };
  if (p.state !== 'running') return { id: 'request', percent: 6 }; // demandée, pas encore prise en charge
  if (/^Téléchargement/.test(p.message || '')) return { id: 'download', percent: 22 };
  const step = p.step || '';
  if (/^Démarrage du panel/.test(step)) return { id: 'restart', percent: 86 };
  if (/^Installation du service/.test(step)) return { id: 'install', percent: 78 };
  if (/^(Copie du panel|Retrait)/.test(step)) return { id: 'install', percent: 66 };
  if (/^(Node\.js|Installation de Node|Création de l)/.test(step)) return { id: 'install', percent: 52 };
  return { id: 'install', percent: 40 };
}

const elapsed = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

function render() {
  if (!overlay) return;
  const { phase, reachable, target, current, finished } = overlay;
  const failed = phase.id === 'failed';
  // en cas d'échec, on garde l'étape où la mise à jour s'est arrêtée
  const index = failed ? overlay.lastIndex : STEPS.findIndex((s) => s.id === phase.id);
  const done = phase.id === 'done';
  const detail = failed
    ? overlay.message || 'La mise à jour a échoué.'
    : !reachable
      ? 'Le panel redémarre avec la nouvelle version : il est indisponible quelques secondes.'
      : phase.id === 'request'
        ? 'En attente du service de mise à jour du Raspberry Pi…'
        : done
          ? 'Mise à jour terminée : rechargement de la page…'
          : overlay.step || overlay.message || 'Mise à jour en cours…';
  setHTML(
    overlay.el,
    html`<div class="update-overlay-card ${failed ? 'failed' : done ? 'done' : ''}">
      <div class="update-overlay-visual">
        ${failed ? html`<div class="update-overlay-icon err">${icon('alert')}</div>` : done ? html`<div class="update-overlay-icon ok">${icon('check')}</div>` : html`<div class="big-spinner" aria-hidden="true"></div>`}
      </div>
      <h2>${failed ? 'La mise à jour a échoué' : done ? 'AstraPanel est à jour' : 'Mise à jour d’AstraPanel en cours'}</h2>
      <p class="update-overlay-target">${target ? html`${current && current !== target ? html`Version ${current} → <b>${target}</b>` : html`Version <b>${target}</b>`}` : 'Nouvelle version'}</p>
      <div class="update-overlay-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${phase.percent}"><i style="width:${phase.percent}%"></i></div>
      <p class="update-overlay-detail" aria-live="polite">${detail}</p>
      <ol class="update-overlay-steps">
        ${STEPS.map((s, i) => {
          const state = i < index || done ? 'ok' : i === index ? (failed ? 'ko' : 'now') : '';
          return html`<li class="${state}"><span class="dot">${state === 'ok' ? icon('check') : state === 'ko' ? icon('x') : ''}</span>${s.label}</li>`;
        })}
      </ol>
      ${failed || finished === 'timeout'
        ? html`<div class="update-overlay-actions">
            ${isAdmin() ? html`<a class="btn" href="#/settings/mises-a-jour" data-close>${icon('terminal')} Voir le journal</a>` : ''}
            <button class="btn btn-primary" data-close>Fermer</button>
          </div>`
        : done
          ? ''
          : html`<p class="update-overlay-hint">Temps écoulé : <span data-elapsed>${elapsed(Date.now() - overlay.startedAt)}</span> · La mise à jour continue sur le Raspberry Pi même si vous fermez cette page.</p>`}
    </div>`,
  );
  overlay.el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeOverlay));
}

function closeOverlay() {
  clearInterval(overlay?.tick);
  overlay?.el.remove();
  document.body.classList.remove('updating');
  overlay = null;
  schedule(IDLE_POLL);
}

// Ouvre l'écran (appelé juste après « Mettre à jour », ou quand le panel détecte une mise à jour en cours).
export function openUpdateOverlay({ target = null, current = null, progress = null } = {}) {
  if (!overlay) {
    const el = document.createElement('div');
    el.className = 'update-overlay';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Mise à jour en cours');
    document.body.append(el);
    document.body.classList.add('updating');
    document.activeElement?.blur?.();
    overlay = { el, startedAt: Date.now(), target, current, reachable: true, phase: { id: 'request', percent: 6 }, lastIndex: 0, step: null, message: null, finished: null };
    overlay.tick = setInterval(() => {
      const span = overlay && $('[data-elapsed]', overlay.el);
      if (span) span.textContent = elapsed(Date.now() - overlay.startedAt);
    }, 1000);
  }
  if (target) overlay.target = target;
  if (current) overlay.current = current;
  if (progress) apply(progress, true);
  else render();
  schedule(ACTIVE_POLL);
}

function apply(p, reachable) {
  if (!overlay) return;
  overlay.reachable = reachable;
  if (reachable) {
    overlay.step = p.step;
    overlay.message = p.message;
    overlay.target = p.target || overlay.target;
    overlay.current ||= p.current;
    // un état « terminé » ou « échoué » antérieur à cet écran ne compte pas
    if ((p.state === 'done' || p.state === 'failed') && p.at && p.at < overlay.startedAt - 10_000) p = { ...p, state: null };
  }
  overlay.phase = phaseOf(p, reachable);
  const index = STEPS.findIndex((x) => x.id === overlay.phase.id);
  if (index >= 0) overlay.lastIndex = index;
  render();
  if (overlay.phase.id === 'done' && !overlay.finished) {
    overlay.finished = 'done';
    setTimeout(clearCacheAndReload, 1500);
  }
  if (overlay.phase.id === 'failed') overlay.finished = 'failed';
  if (!overlay.finished && Date.now() - overlay.startedAt > GIVE_UP) {
    overlay.finished = 'timeout';
    overlay.message = isAdmin()
      ? 'La mise à jour prend plus de 20 minutes : consultez son journal (Paramètres → Mises à jour).'
      : 'La mise à jour prend plus de 20 minutes : prévenez un administrateur.';
    overlay.phase = { id: 'failed', percent: 100 };
    render();
  }
}

async function poll() {
  let progress = null;
  let reachable = true;
  try {
    const res = await fetch('/api/update/progress', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (res.ok) progress = await res.json();
    else reachable = res.status !== 502 && res.status !== 503;
  } catch {
    reachable = false; // le panel redémarre
  }
  if (overlay) {
    if (!overlay.finished) apply(progress || {}, reachable && Boolean(progress));
    if (!overlay.finished) schedule(ACTIVE_POLL);
    return;
  }
  if (progress?.active) {
    openUpdateOverlay({ progress });
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
  if (overlay) {
    clearInterval(overlay.tick);
    overlay.el.remove();
    document.body.classList.remove('updating');
    overlay = null;
  }
}
