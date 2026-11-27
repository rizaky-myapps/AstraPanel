import { api } from '../api.js';
import { renderMarkdown } from '../markdown.js';
import { $, html, icon, pageHero, setHTML } from '../ui.js';
import { state } from '../state.js';

// Libellé du bouton « Retour » d'après la page d'où l'on vient
function returnLabel(hash) {
  if (hash.startsWith('#/settings')) return 'Paramètres';
  if (hash.startsWith('#/apps/')) return state.apps.find((a) => a.id === hash.split('/')[2])?.name || 'Application';
  if (hash.startsWith('#/new')) return 'Nouvelle application';
  if (hash.startsWith('#/storage')) return 'Stockage';
  return 'Tableau de bord';
}

// Tutoriels du dépôt, affichés dans le panel (toujours ceux de la version installée).
export const DOCS = {
  tutoriel: { file: 'TUTORIEL.md', label: 'Installation et utilisation', icon: 'server' },
  cloudflare: { file: 'CLOUDFLARE.md', label: 'Tunnel Cloudflare', icon: 'cloud' },
};
const FILE_TO_DOC = Object.fromEntries(Object.entries(DOCS).map(([id, d]) => [d.file, id]));

export const helpHref = (doc, section = '') => `#/aide/${doc}${section ? `/${encodeURIComponent(section)}` : ''}`;

export async function renderHelp(view, page, doc = 'tutoriel', section = '') {
  if (!DOCS[doc]) doc = 'tutoriel';
  const root = document.createElement('div');
  view.replaceChildren(root);
  setHTML(
    root,
    html`<a class="back keep" href="${state.returnTo || '#/'}">${icon('back')} ${returnLabel(state.returnTo || '#/')}</a>
      ${pageHero({ icon: 'book', tone: 'cyan', title: 'Aide', info: 'Les tutoriels d’AstraPanel, en français, pour la version installée.' })}
      <nav class="tabs">${Object.entries(DOCS).map(([id, d]) => html`<a href="${helpHref(id)}" class="${id === doc ? 'active' : ''}">${icon(d.icon)} ${d.label}</a>`)}</nav>
      <article class="card doc" id="doc"><div class="card-body row"><div class="spinner sm"></div><span class="muted">Chargement…</span></div></article>`,
  );
  const { markdown } = await api.get(`/docs/${doc}`);
  if (!page.active) return;

  const article = $('#doc', root);
  article.innerHTML = renderMarkdown(markdown, {
    image: (src) => (/^images\//.test(src) ? `/docs/${src}` : ''),
    link(label, href) {
      if (href.startsWith('#')) return `<a href="${helpHref(doc, href.slice(1))}" data-anchor="${href.slice(1)}">${label}</a>`;
      const local = /^([A-Z]+\.md)(?:#(.*))?$/.exec(href);
      if (local && FILE_TO_DOC[local[1]]) return `<a href="${helpHref(FILE_TO_DOC[local[1]], local[2] || '')}">${label}</a>`;
      if (/^https?:\/\//.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
      return label;
    },
  });

  // Liens vers une section de la même page : défilement sans recharger la page
  const scrollTo = (id, smooth) => {
    const target = id && article.querySelector(`[id="${CSS.escape(id)}"]`);
    if (target) target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  };
  article.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-anchor]');
    if (!a) return;
    e.preventDefault();
    scrollTo(a.dataset.anchor, true);
    history.replaceState(null, '', helpHref(doc, a.dataset.anchor));
  });
  if (section) requestAnimationFrame(() => scrollTo(section, false));
}
