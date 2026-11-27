// Couleurs des terminaux (séquences ANSI « SGR » : \x1b[…m) → texte coloré dans les consoles du panel.
// Gère les 16 couleurs (normales et vives), les 256 couleurs, les couleurs RVB (24 bits), le gras, le pâle,
// l'italique, le souligné, le barré, l'inversion et le masquage. L'état (couleur en cours…) peut se poursuivre
// d'une ligne à la suivante, comme dans un vrai terminal.

// Palette des 16 couleurs, réglée pour le fond sombre des consoles
export const PALETTE = [
  '#4b5263', '#ff5c6c', '#4ade80', '#facc15', '#60a5fa', '#e879f9', '#22d3ee', '#d4d8e1',
  '#7c8496', '#ff8a95', '#86efac', '#fde68a', '#93c5fd', '#f0abfc', '#67e8f9', '#ffffff',
];
const DEFAULT_FG = '#f1f3f9';
const DEFAULT_BG = '#08090b';

const SGR_RE = /\x1b\[([0-9;:]*)m/g;
const OTHER_ESC_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]|\x1b/g;

// Couleur n° 0 à 255 (palette xterm)
export function color256(n) {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return PALETTE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  const i = n - 16;
  const level = (c) => (c ? 55 + c * 40 : 0);
  return `rgb(${level(Math.floor(i / 36))}, ${level(Math.floor(i / 6) % 6)}, ${level(i % 6)})`;
}

const rgb = (r, g, b) => ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? `rgb(${r}, ${g}, ${b})` : null);

export const newState = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false, hidden: false });

// Couleur étendue (38 / 48) : « 5;n » ou « 2;r;g;b », en paramètres séparés par « ; » ou en sous-paramètres « : »
function extendedColor(parts) {
  const [mode, ...rest] = parts;
  if (mode === 5) return color256(rest[0]);
  if (mode === 2) return rgb(...rest.slice(-3));
  return null;
}

// Applique une séquence SGR à l'état
export function applySgr(state, params) {
  const codes = params === '' ? ['0'] : params.split(';');
  for (let i = 0; i < codes.length; i++) {
    const raw = codes[i];
    if (raw.includes(':')) {
      // forme « 38:2::255:0:0 » ou « 4:3 »
      const sub = raw.split(':').map((v) => (v === '' ? null : Number(v)));
      if (sub[0] === 38 || sub[0] === 48) {
        const c = extendedColor(sub.slice(1).filter((v, k) => !(sub[1] === 2 && k === 1 && v === null)));
        if (sub[0] === 38) state.fg = c;
        else state.bg = c;
      } else if (sub[0] === 4) state.underline = sub[1] !== 0;
      continue;
    }
    const code = raw === '' ? 0 : Number(raw);
    if (code === 38 || code === 48) {
      const mode = Number(codes[i + 1]);
      const take = mode === 5 ? 2 : mode === 2 ? 4 : 1;
      const c = extendedColor(codes.slice(i + 1, i + 1 + take).map(Number));
      i += take;
      if (code === 38) state.fg = c;
      else state.bg = c;
      continue;
    }
    if (code === 0) Object.assign(state, newState());
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 8) state.hidden = true;
    else if (code === 9) state.strike = true;
    else if (code === 21 || code === 22) state.bold = state.dim = false;
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 28) state.hidden = false;
    else if (code === 29) state.strike = false;
    else if (code >= 30 && code <= 37) state.fg = PALETTE[code - 30];
    else if (code === 39) state.fg = null;
    else if (code >= 40 && code <= 47) state.bg = PALETTE[code - 40];
    else if (code === 49) state.bg = null;
    else if (code >= 90 && code <= 97) state.fg = PALETTE[code - 90 + 8];
    else if (code >= 100 && code <= 107) state.bg = PALETTE[code - 100 + 8];
  }
  return state;
}

// Style CSS d'un morceau de texte, d'après l'état (null : texte sans mise en forme)
export function styleOf(state) {
  let { fg, bg } = state;
  if (state.inverse) [fg, bg] = [bg || DEFAULT_BG, fg || DEFAULT_FG];
  const style = {};
  if (fg) style.color = fg;
  if (bg) style.backgroundColor = bg;
  if (state.hidden) style.color = 'transparent';
  if (state.bold) style.fontWeight = '700';
  if (state.dim) style.opacity = '0.65';
  if (state.italic) style.fontStyle = 'italic';
  const lines = [state.underline && 'underline', state.strike && 'line-through'].filter(Boolean);
  if (lines.length) style.textDecoration = lines.join(' ');
  return Object.keys(style).length ? style : null;
}

/**
 * Découpe une ligne en morceaux [{ text, style }] ; `state` (facultatif) est mis à jour, pour continuer sur la
 * ligne suivante. Les autres séquences d'échappement (curseur, effacement…) sont ignorées.
 */
export function parseAnsi(text, state = newState()) {
  const parts = [];
  const push = (chunk) => {
    const clean = chunk.replace(OTHER_ESC_RE, '');
    if (!clean) return;
    const style = styleOf(state);
    const last = parts.at(-1);
    if (last && JSON.stringify(last.style) === JSON.stringify(style)) last.text += clean;
    else parts.push({ text: clean, style });
  };
  let from = 0;
  SGR_RE.lastIndex = 0;
  for (let m; (m = SGR_RE.exec(text)); ) {
    push(text.slice(from, m.index));
    applySgr(state, m[1]);
    from = SGR_RE.lastIndex;
  }
  push(text.slice(from));
  return parts;
}

export const stripAnsi = (text) => String(text).replace(OTHER_ESC_RE, '');

// Remplit `el` avec le texte coloré (nœuds texte et <span> stylés, jamais de HTML interprété)
export function renderAnsi(el, text, state) {
  el.textContent = '';
  for (const { text: chunk, style } of parseAnsi(String(text), state)) {
    if (!style) {
      el.append(chunk);
      continue;
    }
    const span = document.createElement('span');
    Object.assign(span.style, style);
    span.textContent = chunk;
    el.append(span);
  }
}
