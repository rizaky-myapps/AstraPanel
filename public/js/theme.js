// Apparence du panel : thème (automatique, clair, sombre) et couleur d'accent.
// Le choix est enregistré avec le compte ; une copie locale l'applique dès le chargement (écran de connexion compris),
// sans attendre le serveur.

export const ACCENTS = [
  { id: 'solaire', label: 'Solaire' },
  { id: 'ocean', label: 'Océan' },
  { id: 'aurore', label: 'Aurore' },
  { id: 'nebuleuse', label: 'Nébuleuse' },
  { id: 'framboise', label: 'Framboise' },
];
export const THEMES = [
  { id: 'auto', label: 'Automatique', icon: 'monitor' },
  { id: 'light', label: 'Clair', icon: 'sun' },
  { id: 'dark', label: 'Sombre', icon: 'moon' },
];
const KEY = 'astra.appearance';
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
let current = { theme: 'auto', accent: 'solaire' };

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
  current = { theme, accent };
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (accent === 'solaire') delete root.dataset.accent;
  else root.dataset.accent = accent;
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
