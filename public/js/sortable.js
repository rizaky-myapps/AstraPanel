// Glisser-déposer pour ranger des éléments (applications de la barre latérale, tuiles du tableau de bord).
//
// - souris / stylet : on glisse dès que le pointeur bouge de quelques pixels (un simple clic ouvre le lien) ;
// - tactile : appui long, puis on glisse (un glissement immédiat fait défiler la page, comme d'habitude) ;
// - clavier : Alt + ↑ / ↓ déplace l'élément qui a le focus (pas Alt + ← / →, raccourci « page précédente ») ;
// - Échap pendant un glissement : tout revient à sa place.
//
// Un élément ne se déplace que parmi ses voisins du même conteneur (et du même groupe, data-group) ;
// les conteneurs reçoivent la classe « sort-list » (position relative, utilisée pour les calculs).
const DRAG_DISTANCE = 5;
const LONG_PRESS = 380;
const TOUCH_SLOP = 8;
const ANIM = { duration: 170, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' };
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/**
 * @param {HTMLElement} container  zone contenant les listes (délégation : son contenu peut être redessiné)
 * @param {{ item: string, onSort: (ids: string[]) => void }} options
 *   item : sélecteur des éléments déplaçables (chacun porte data-id) ;
 *   onSort : appelé avec les data-id de tous les éléments de la zone, dans le nouvel ordre, après un déplacement.
 * @returns {{ busy: () => boolean, destroy: () => void }} busy() : vrai pendant un glissement (ne pas redessiner)
 */
export function makeSortable(container, { item, onSort }) {
  let drag = null;
  let settling = false;
  let suppressClickUntil = 0;

  const isItem = (n) => n instanceof HTMLElement && n.matches(item);
  const sameGroup = (a, b) => a.parentElement === b.parentElement && (a.dataset.group || '') === (b.dataset.group || '');
  const peers = (el) => [...el.parentElement.children].filter((n) => isItem(n) && sameGroup(n, el));
  const allIds = () => [...container.querySelectorAll(item)].map((n) => n.dataset.id);

  // Position « au repos » d'un élément (sans la translation du glissement ni les animations en cours)
  const restRect = (el) => {
    const list = el.offsetParent || el.parentElement;
    const lr = list.getBoundingClientRect();
    const left = lr.left + list.clientLeft + el.offsetLeft - list.scrollLeft;
    const top = lr.top + list.clientTop + el.offsetTop - list.scrollTop;
    return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight, width: el.offsetWidth, height: el.offsetHeight };
  };

  // Déplace des voisins autour de l'élément glissé (lui ne bouge pas dans le DOM), avec une animation FLIP
  function moveAround(el, nodes, where) {
    const first = new Map(nodes.map((n) => [n, n.getBoundingClientRect()]));
    if (where === 'after') el.after(...nodes);
    else el.before(...nodes);
    if (reducedMotion()) return;
    for (const n of nodes) {
      n.getAnimations().forEach((a) => a.cancel());
      const a = first.get(n);
      const b = n.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (dx || dy) n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], ANIM);
    }
  }

  // L'élément glissé suit le pointeur, sans sortir de sa liste
  function follow() {
    const { el } = drag;
    const r = restRect(el);
    const box = el.parentElement.getBoundingClientRect();
    const dx = clamp(drag.cx - drag.grabX - r.left, box.left - r.left, box.right - r.right);
    const dy = clamp(drag.cy - drag.grabY - r.top, box.top - r.top, box.bottom - r.bottom);
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    return { x: r.left + dx + r.width / 2, y: r.top + dy + r.height / 2 };
  }

  function reorder(center) {
    const { el } = drag;
    const list = peers(el);
    const target = list.find((n) => {
      if (n === el) return false;
      const r = restRect(n);
      return center.x >= r.left && center.x <= r.right && center.y >= r.top && center.y <= r.bottom;
    });
    if (!target) return false;
    const from = list.indexOf(el);
    const to = list.indexOf(target);
    // vers le haut : les éléments entre la cible et lui passent après lui ; vers le bas : avant lui
    if (to < from) moveAround(el, list.slice(to, from), 'after');
    else moveAround(el, list.slice(from + 1, to + 1), 'before');
    return true;
  }

  // tactile : une fois le glissement commencé, le doigt ne fait plus défiler la page. L'écouteur est posé dès le départ
  // (non passif) sur la zone : le navigateur doit le connaître au moment où le doigt se pose.
  const preventScroll = (e) => drag?.started && e.cancelable && e.preventDefault();
  const preventMenu = (e) => e.preventDefault();

  function start() {
    clearTimeout(drag.timer);
    // la liste a pu être redessinée entre l'appui et le début du glissement : on reprend le même élément
    if (!drag.el.isConnected) {
      const again = [...container.querySelectorAll(item)].find((n) => n.dataset.id === drag.el.dataset.id);
      if (!again) return finish(false);
      drag.el = again;
    }
    const { el } = drag;
    drag.started = true;
    const r = el.getBoundingClientRect();
    drag.grabX = drag.x - r.left;
    drag.grabY = drag.y - r.top;
    drag.initial = peers(el);
    drag.anchor = drag.initial.at(-1).nextSibling;
    el.classList.add('sorting');
    el.parentElement.classList.add('sorting-list');
    document.documentElement.classList.add('is-sorting');
    if (drag.touch) navigator.vibrate?.(12);
    reorder(follow());
  }

  function cleanup() {
    clearTimeout(drag.timer);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
    document.removeEventListener('keydown', onEscape, true);
    document.removeEventListener('contextmenu', preventMenu, true);
    document.documentElement.classList.remove('is-sorting');
    drag.el.classList.remove('sorting');
    drag.el.parentElement?.classList.remove('sorting-list');
  }

  // Fin du glissement : l'élément rejoint sa place en douceur, puis l'ordre est transmis
  function finish(commit) {
    const d = drag;
    cleanup();
    drag = null;
    if (!d.started) return;
    suppressClickUntil = Date.now() + 400;
    if (!commit) {
      // retour à l'ordre de départ
      d.initial.forEach((n) => d.el.parentElement.insertBefore(n, d.anchor));
    }
    const was = d.el.style.transform;
    d.el.style.transform = '';
    const before = d.order;
    const after = allIds();
    const changed = commit && after.join('\n') !== before.join('\n');
    const done = () => {
      settling = false;
      if (changed) onSort(after);
    };
    if (was && !reducedMotion()) {
      settling = true;
      d.el.animate([{ transform: was }, { transform: 'none' }], ANIM).finished.then(done, done);
    } else done();
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag.cx = e.clientX;
    drag.cy = e.clientY;
    if (!drag.started) {
      const dist = Math.hypot(drag.cx - drag.x, drag.cy - drag.y);
      if (drag.touch) {
        if (dist > TOUCH_SLOP) finish(false); // l'utilisateur fait défiler : pas de glissement
        return;
      }
      if (dist < DRAG_DISTANCE) return;
      start();
    }
    e.preventDefault();
    const center = follow();
    if (reorder(center)) follow();
  }

  function onUp(e) {
    if (drag && e.pointerId === drag.id) finish(true);
  }
  function onCancel(e) {
    if (drag && e.pointerId === drag.id) finish(false);
  }
  function onEscape(e) {
    if (e.key === 'Escape' && drag?.started) {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  }

  function onPointerDown(e) {
    if (drag || settling || e.button !== 0 || !e.isPrimary) return;
    const el = e.target.closest(item);
    if (!el || !container.contains(el) || peers(el).length < 2) return;
    drag = { el, id: e.pointerId, x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, touch: e.pointerType === 'touch', started: false, order: allIds() };
    if (drag.touch) {
      drag.timer = setTimeout(start, LONG_PRESS);
      document.addEventListener('contextmenu', preventMenu, true);
    }
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onCancel, true);
    document.addEventListener('keydown', onEscape, true);
  }

  // après un glissement, le relâchement ne doit pas ouvrir le lien
  function onClick(e) {
    if (Date.now() < suppressClickUntil && e.target.closest(item)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  // pas de glisser-déposer natif des liens (il interromprait le nôtre)
  function onDragStart(e) {
    if (e.target.closest?.(item)) e.preventDefault();
  }

  // Clavier : Alt + ↑ (avant) ou Alt + ↓ (après)
  function onKey(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || drag) return;
    const step = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    const el = step && e.target.closest?.(item);
    if (!el || !container.contains(el)) return;
    e.preventDefault();
    const list = peers(el);
    const neighbour = list[list.indexOf(el) + step];
    if (!neighbour) return;
    const before = allIds().join('\n');
    // on déplace le voisin plutôt que l'élément : il garde le focus
    moveAround(el, [neighbour], step < 0 ? 'after' : 'before');
    const after = allIds();
    if (after.join('\n') === before) return;
    const id = el.dataset.id;
    onSort(after);
    // la liste a pu être redessinée : on remet le focus sur le même élément
    const again = [...container.querySelectorAll(item)].find((n) => n.dataset.id === id);
    if (again && again !== document.activeElement) again.focus();
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('click', onClick, true);
  container.addEventListener('dragstart', onDragStart);
  container.addEventListener('keydown', onKey);
  container.addEventListener('touchmove', preventScroll, { passive: false });
  return {
    // vrai dès l'appui (jusqu'à la fin de l'animation de dépôt) : la liste ne doit pas être redessinée entre-temps
    busy: () => Boolean(drag) || settling,
    destroy() {
      if (drag) finish(false);
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('click', onClick, true);
      container.removeEventListener('dragstart', onDragStart);
      container.removeEventListener('keydown', onKey);
      container.removeEventListener('touchmove', preventScroll);
    },
  };
}
