// Adresses du panel, sans « # » (History API) : /home pour le tableau de bord, /apps/<id>/console, /settings/compte…
// Le serveur renvoie index.html pour chacune de ces adresses (voir src/http/panel-assets.js).

export const HOME = '/home';
// Premières parties d'adresse qui appartiennent à l'interface (le reste : /api, /hooks, /docs/images, fichiers…)
const APP_PATH_RE = /^\/(?:home|new|apps|settings|storage|aide)(?:\/|$)/;
export const isAppPath = (pathname) => APP_PATH_RE.test(pathname);

export function currentPath() {
  try {
    return decodeURI(location.pathname);
  } catch {
    return location.pathname;
  }
}

const notify = () => window.dispatchEvent(new Event('astra:navigate'));

// Change de page. Une adresse identique à la page affichée ne fait rien (comme un lien vers la page en cours).
export function navigate(to, { replace = false } = {}) {
  let url = String(to || '');
  if (url.startsWith('#')) url = url.slice(1); // ancienne forme « #/… »
  if (url === '' || url === '/') url = HOME;
  if (url === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  notify();
}

// Ré-affiche la page en cours (après un changement de configuration…)
export const refreshRoute = notify;

export function onNavigate(fn) {
  window.addEventListener('astra:navigate', fn);
  return () => window.removeEventListener('astra:navigate', fn);
}

let ready = false;
export function initRouter() {
  if (ready) return;
  ready = true;
  // anciennes adresses « /#/apps/… » (favoris, liens d'une version précédente) et « / » : converties
  if (location.hash.startsWith('#/')) {
    const path = location.hash.slice(1);
    history.replaceState(null, '', path === '/' ? HOME : path);
  } else if (location.pathname === '/' || location.pathname === '/index.html') {
    history.replaceState(null, '', HOME + location.search);
  }
  window.addEventListener('popstate', notify);
  // liens internes : changement de page sans rechargement (Ctrl / Maj / clic du milieu : comportement normal)
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href]');
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    const raw = a.getAttribute('href');
    if (!raw || raw.startsWith('#')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !isAppPath(url.pathname)) return;
    e.preventDefault();
    navigate(url.pathname + url.search);
  });
}
