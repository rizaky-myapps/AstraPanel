import { $, html, icon, setHTML } from './ui.js';

// Écran d'attente : tout le panel est flouté, avec au centre un chargement, un titre, une barre d'avancement, le
// détail de ce qui se passe et la liste des étapes. Utilisé pour les mises à jour, le redémarrage de la machine et
// la création d'une application.
//
// const screen = openOverlay('Création de l’application');
// screen.render({ status: 'busy', title, subtitle, percent, detail, steps: [{ label, state: 'ok' | 'now' | 'ko' | '' }],
//                 hint, actions: [{ label, primary, href, icon, onClick }] });
// screen.close();

const elapsedText = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

export function openOverlay(label) {
  const el = document.createElement('div');
  el.className = 'update-overlay';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', label);
  document.body.append(el);
  document.body.classList.add('updating');
  document.activeElement?.blur?.();
  const startedAt = Date.now();
  // temps écoulé, mis à jour chaque seconde si le texte d'aide le contient
  const tick = setInterval(() => {
    const span = $('[data-elapsed]', el);
    if (span) span.textContent = elapsedText(Date.now() - startedAt);
  }, 1000);
  let closed = false;

  return {
    el,
    startedAt,
    elapsed: () => elapsedText(Date.now() - startedAt),
    get closed() {
      return closed;
    },
    render({ status = 'busy', title, subtitle = '', percent = null, detail = '', steps = [], hint = '', actions = [] }) {
      if (closed) return;
      const failed = status === 'failed';
      const done = status === 'done';
      setHTML(
        el,
        html`<div class="update-overlay-card ${failed ? 'failed' : done ? 'done' : ''}">
          <div class="update-overlay-visual">
            ${failed ? html`<div class="update-overlay-icon err">${icon('alert')}</div>` : done ? html`<div class="update-overlay-icon ok">${icon('check')}</div>` : html`<div class="big-spinner" aria-hidden="true"></div>`}
          </div>
          <h2>${title}</h2>
          ${subtitle ? html`<p class="update-overlay-target">${subtitle}</p>` : ''}
          ${percent === null
            ? ''
            : html`<div class="update-overlay-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><i style="width:${Math.round(percent)}%"></i></div>`}
          <p class="update-overlay-detail" aria-live="polite">${detail}</p>
          ${steps.length
            ? html`<ol class="update-overlay-steps">
                ${steps.map((s) => html`<li class="${s.state || ''}"><span class="dot">${s.state === 'ok' ? icon('check') : s.state === 'ko' ? icon('x') : ''}</span>${s.label}</li>`)}
              </ol>`
            : ''}
          ${actions.length
            ? html`<div class="update-overlay-actions">
                ${actions.map((a, i) =>
                  a.href
                    ? html`<a class="btn ${a.primary ? 'btn-primary' : ''}" href="${a.href}" data-action="${i}">${a.icon ? icon(a.icon) : ''} ${a.label}</a>`
                    : html`<button class="btn ${a.primary ? 'btn-primary' : ''}" data-action="${i}">${a.icon ? icon(a.icon) : ''} ${a.label}</button>`,
                )}
              </div>`
            : hint
              ? html`<p class="update-overlay-hint">${hint}</p>`
              : ''}
        </div>`,
      );
      el.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => actions[Number(b.dataset.action)].onClick?.()));
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(tick);
      el.classList.add('closing');
      document.body.classList.remove('updating');
      setTimeout(() => el.remove(), 200);
    },
  };
}

// Étapes : celles avant `index` sont faites, `index` est en cours (ou en échec), les suivantes à venir.
export function stepsAt(labels, index, { done = false, failed = false } = {}) {
  return labels.map((label, i) => ({ label, state: done || i < index ? 'ok' : i === index ? (failed ? 'ko' : 'now') : '' }));
}

// Texte « Temps écoulé : … » mis à jour en direct par l'écran.
export const elapsedHint = (screen, after = '') => html`Temps écoulé : <span data-elapsed>${screen.elapsed()}</span>${after ? html` · ${after}` : ''}`;
