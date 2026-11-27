// Apparence du panel : thème (automatique, clair, sombre) et couleur d'accent (prédéfinie, ou dégradé personnalisé).
// Le choix est enregistré avec le compte ; une copie locale l'applique dès le chargement (écran de connexion compris),
// sans attendre le serveur.

export const ACCENTS = [
  { id: 'solaire', label: 'Solaire' },
  { id: 'ocean', label: 'Océan' },
  { id: 'aurore', label: 'Aurore' },
  { id: 'nebuleuse', label: 'Nébuleuse' },
  { id: 'framboise', label: 'Framboise' },
  { id: 'crepuscule', label: 'Crépuscule' },
  { id: 'lagon', label: 'Lagon' },
  { id: 'foret', label: 'Forêt' },
  { id: 'lave', label: 'Lave' },
  { id: 'glacier', label: 'Glacier' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'custom', label: 'Personnalisé' },
];
export const DEFAULT_CUSTOM = { from: '#ff6b35', to: '#8b5cf6' };
const HEX = /^#[0-9a-f]{6}$/i;
const validCustom = (c) => (c && HEX.test(c.from || '') && HEX.test(c.to || '') ? { from: c.from.toLowerCase(), to: c.to.toLowerCase() } : null);

// ---- Thème personnalisé : les jetons d'accent calculés à partir des deux couleurs du dégradé ----
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
// luminance relative (0 = noir, 1 = blanc)
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
// éclaircit (ou assombrit) jusqu'à une luminance lisible : texte d'accent sur fond sombre (ou clair)
function towards(rgb, target, test) {
  let out = rgb;
  for (let t = 0; t <= 1 && !test(out); t += 0.05) out = mix(rgb, target, t);
  return out;
}
const CUSTOM_VARS = ['--accent', '--accent-rgb', '--accent-2', '--accent-2-rgb', '--accent-3-rgb', '--accent-light', '--accent-deep', '--custom-from', '--custom-to'];
export function customVars({ from, to }) {
  const a = hexRgb(from);
  const b = hexRgb(to);
  return {
    '--accent': from,
    '--accent-rgb': a.join(', '),
    '--accent-2': to,
    '--accent-2-rgb': b.join(', '),
    '--accent-3-rgb': mix(a, b, 0.5).join(', '),
    '--accent-light': hex(towards(mix(a, [255, 255, 255], 0.35), [255, 255, 255], (c) => luminance(c) >= 0.42)),
    '--accent-deep': hex(towards(mix(a, [0, 0, 0], 0.3), [0, 0, 0], (c) => luminance(c) <= 0.16)),
    '--custom-from': from,
    '--custom-to': to,
  };
}
export const THEMES = [
  { id: 'auto', label: 'Automatique', icon: 'monitor' },
  { id: 'light', label: 'Clair', icon: 'sun' },
  { id: 'dark', label: 'Sombre', icon: 'moon' },
];
const KEY = 'astra.appearance';
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
let current = { theme: 'auto', accent: 'solaire', custom: DEFAULT_CUSTOM };

// Thème réellement affiché (« auto » suit le système)
export const effectiveTheme = () => (current.theme === 'auto' ? (systemLight.matches ? 'light' : 'dark') : current.theme);
export const appearance = () => ({ ...current });

function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0b0c0f';
}

export function applyAppearance(prefs = {}) {
  const theme = THEMES.some((t) => t.id === prefs.theme) ? prefs.theme : 'auto';
  const accent = ACCENTS.some((a) => a.id === prefs.accent) ? prefs.accent : 'solaire';
  const custom = validCustom(prefs.custom) || DEFAULT_CUSTOM;
  current = { theme, accent, custom };
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (accent === 'solaire') delete root.dataset.accent;
  else root.dataset.accent = accent;
  // dégradé personnalisé : variables posées sur <html> (elles passent avant celles de la feuille de style)
  for (const name of CUSTOM_VARS) root.style.removeProperty(name);
  const vars = customVars(custom);
  if (accent === 'custom') for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  else {
    // l'aperçu de la pastille « Personnalisé » garde les couleurs choisies
    root.style.setProperty('--custom-from', custom.from);
    root.style.setProperty('--custom-to', custom.to);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // stockage indisponible : le choix du compte s'appliquera après la connexion
  }
  syncThemeColor();
  window.dispatchEvent(new Event('astra:theme'));
}

// Au chargement de la page : dernier choix connu sur cet appareil
export function initAppearance() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    saved = null;
  }
  applyAppearance(saved || {});
  systemLight.addEventListener('change', () => {
    syncThemeColor();
    window.dispatchEvent(new Event('astra:theme'));
  });
}
