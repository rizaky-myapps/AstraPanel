// Graphique en ligne (SVG) : une série temporelle, réticule + infobulle au survol et au clavier.
const SVG = 'http://www.w3.org/2000/svg';
const HEIGHT = 190;
const M = { top: 12, right: 14, bottom: 26, left: 46 };
const TIME_STEPS = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880, 4320, 7200, 10080].map((m) => m * 60_000);

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

// Graduations « rondes » entre min et max
export function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) || 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

function timeTicks(start, end, width) {
  const wanted = Math.max(2, Math.floor(width / 85));
  const step = TIME_STEPS.find((s) => (end - start) / s <= wanted) || TIME_STEPS.at(-1);
  // alignées sur l'heure locale (minuit, heures pleines…)
  const offset = new Date(start).getTimezoneOffset() * 60_000;
  const ticks = [];
  for (let t = Math.ceil((start - offset) / step) * step + offset; t <= end; t += step) ticks.push(t);
  return { ticks, step };
}

function formatTick(t, step) {
  const d = new Date(t);
  if (step >= 86_400_000) return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  if (step >= 21_600_000 && d.getHours() === 0) return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// Date d'un point : avec le jour dès que la période dépasse une demi-journée
export function formatWhen(t, step, span = 0) {
  const d = new Date(t);
  const opts = step >= 5 * 60_000 || span > 12 * 3600_000 ? { dateStyle: 'short', timeStyle: 'short' } : { timeStyle: step < 60_000 ? 'medium' : 'short' };
  return d.toLocaleString('fr-FR', opts);
}

/**
 * Dessine (ou redessine) le graphique dans `container`.
 * options : points [[t, valeur]], start, end, step (ms), domain [min, max], format(v), label
 */
export function renderLineChart(container, { points, start, end, step, domain, format, label }) {
  container.classList.add('chart');
  container.replaceChildren();
  const width = Math.max(260, container.clientWidth);
  const w = width - M.left - M.right;
  const h = HEIGHT - M.top - M.bottom;
  const [yMin, yMax] = domain;
  const x = (t) => M.left + ((t - start) / (end - start)) * w;
  const y = (v) => M.top + h - ((v - yMin) / (yMax - yMin || 1)) * h;

  const svg = el('svg', { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: 'img', 'aria-label': label, tabindex: '0' }, container);

  // Grille et graduations
  for (const v of niceTicks(yMin, yMax, 4)) {
    el('line', { x1: M.left, x2: width - M.right, y1: y(v), y2: y(v), class: 'grid' }, svg);
    el('text', { x: M.left - 8, y: y(v), class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg).textContent = format(v, true);
  }
  const { ticks, step: tickStep } = timeTicks(start, end, w);
  for (const t of ticks) {
    el('text', { x: x(t), y: HEIGHT - 8, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = formatTick(t, tickStep);
  }
  el('line', { x1: M.left, x2: width - M.right, y1: M.top + h, y2: M.top + h, class: 'axis' }, svg);

  const valid = points.filter((p) => p[1] !== null && p[1] !== undefined && p[0] >= start - step);
  if (!valid.length) {
    el('text', { x: M.left + w / 2, y: M.top + h / 2, class: 'empty', 'text-anchor': 'middle' }, svg).textContent =
      'Pas encore de données pour cette période';
    return;
  }

  // Segments : la courbe s'interrompt quand il manque des mesures (panel arrêté…)
  const segments = [];
  let current = [];
  for (const p of valid) {
    const prev = current.at(-1);
    if (prev && p[0] - prev[0] > step * 2.5) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  }
  segments.push(current);
  const clampY = (v) => y(Math.max(yMin, Math.min(yMax, v)));
  for (const seg of segments) {
    const line = seg.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${clampY(p[1]).toFixed(1)}`).join('');
    if (seg.length > 1) {
      el('path', { d: `${line}L${x(seg.at(-1)[0]).toFixed(1)},${M.top + h}L${x(seg[0][0]).toFixed(1)},${M.top + h}Z`, class: 'area' }, svg);
      el('path', { d: line, class: 'line' }, svg);
    } else {
      el('circle', { cx: x(seg[0][0]), cy: clampY(seg[0][1]), r: 2, class: 'line-dot' }, svg);
    }
  }
  // Dernière valeur mise en avant
  const last = valid.at(-1);
  el('circle', { cx: x(last[0]), cy: clampY(last[1]), r: 4, class: 'end-dot' }, svg);

  // Réticule + infobulle
  const cross = el('line', { y1: M.top, y2: M.top + h, class: 'crosshair', visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 4, class: 'end-dot', visibility: 'hidden' }, svg);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  const tipValue = document.createElement('strong');
  const tipTime = document.createElement('span');
  tip.append(tipValue, tipTime);
  container.appendChild(tip);

  let index = valid.length - 1;
  const show = (i) => {
    index = Math.max(0, Math.min(valid.length - 1, i));
    const [t, v] = valid[index];
    const px = x(t);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    dot.setAttribute('cx', px);
    dot.setAttribute('cy', clampY(v));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    tipValue.textContent = format(v);
    tipTime.textContent = formatWhen(t, step, end - start);
    tip.hidden = false;
    const left = Math.min(Math.max(px - tip.offsetWidth / 2, 0), width - tip.offsetWidth);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, clampY(v) - tip.offsetHeight - 12)}px`;
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  const nearest = (px) => {
    const t = start + ((px - M.left) / w) * (end - start);
    let lo = 0;
    let hi = valid.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (valid[mid][0] < t) lo = mid;
      else hi = mid;
    }
    return Math.abs(valid[lo][0] - t) <= Math.abs(valid[hi][0] - t) ? lo : hi;
  };
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    show(nearest(e.clientX - rect.left));
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(index));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, PageDown: -10, PageUp: 10, Home: -Infinity, End: Infinity };
    if (!(e.key in moves)) return;
    e.preventDefault();
    show(Number.isFinite(moves[e.key]) ? index + moves[e.key] : moves[e.key] < 0 ? 0 : valid.length - 1);
  });
}
