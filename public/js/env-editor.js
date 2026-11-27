import { $, $$, html, icon, setHTML, toast } from './ui.js';

// Lit un contenu au format .env (KEY=valeur, commentaires #, guillemets optionnels).
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) throw new Error(`Ligne invalide : ${line}`);
    let value = m[2];
    if (/^".*"$/.test(value)) value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    else if (/^'.*'$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

export function toDotenv(env) {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${/[\s#"'\\]/.test(v) || v.includes('\n') ? JSON.stringify(v) : v}`)
    .join('\n');
}

/**
 * Éditeur de variables d'environnement (lignes clé / valeur ou mode texte .env).
 * modeSlot : élément où placer le bouton « Mode texte / Mode tableau » (sinon, au-dessus de l'éditeur).
 * onRender(textMode) : appelé après chaque affichage.
 * Retourne { getValue() } qui lève une erreur si la saisie est invalide.
 */
export function envEditor(container, initial = {}, { modeSlot = null, onRender = null } = {}) {
  let textMode = false;
  let env = { ...initial };
  const modeButton = () =>
    html`<button type="button" class="btn btn-ghost btn-sm" data-mode>${icon(textMode ? 'sliders' : 'file')} ${textMode ? 'Mode tableau' : 'Mode texte (.env)'}</button>`;

  const row = (key = '', value = '') => html`<div class="kv">
    <input type="text" class="mono kv-key" placeholder="NOM_VARIABLE" value="${key}" spellcheck="false" autocomplete="off" />
    <div class="input-group kv-value">
      <input type="password" class="mono" placeholder="valeur" value="${value}" spellcheck="false" autocomplete="off" />
      <button type="button" class="btn btn-ghost btn-icon" data-toggle title="Afficher / masquer">${icon('eye')}</button>
    </div>
    <button type="button" class="btn btn-ghost btn-icon" data-remove title="Supprimer">${icon('trash')}</button>
  </div>`;

  function readRows() {
    const out = {};
    for (const el of $$('.kv', container)) {
      const key = $('.kv-key', el).value.trim();
      const value = $('.kv-value input', el).value;
      if (!key && !value) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Nom de variable invalide : « ${key} »`);
      out[key] = value;
    }
    return out;
  }

  function render() {
    const entries = Object.entries(env);
    if (modeSlot) setHTML(modeSlot, modeButton());
    container.classList.toggle('env-text-mode', textMode);
    setHTML(
      container,
      html`${modeSlot ? '' : html`<div class="row env-toolbar"><span class="spacer"></span>${modeButton()}</div>`}
        ${textMode
          ? html`<textarea class="mono env-text" rows="10" spellcheck="false" placeholder="Une variable par ligne : NOM=valeur (vous pouvez coller un fichier .env)">${toDotenv(env)}</textarea>`
          : html`<div class="kv-rows">${entries.length ? entries.map(([k, v]) => row(k, v)) : row()}</div>
              <button type="button" class="btn btn-sm" data-add>${icon('plus')} Ajouter une variable</button>`}`,
    );
    onRender?.(textMode);
  }

  const onClick = (e) => {
    const target = e.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-add')) {
      $('.kv-rows', container).insertAdjacentHTML('beforeend', String(row()));
      $$('.kv-key', container).at(-1).focus();
    } else if (target.hasAttribute('data-remove')) {
      target.closest('.kv').remove();
      if (!$('.kv', container)) $('.kv-rows', container).insertAdjacentHTML('beforeend', String(row()));
    } else if (target.hasAttribute('data-toggle')) {
      const input = target.parentElement.querySelector('input');
      input.type = input.type === 'password' ? 'text' : 'password';
    } else if (target.hasAttribute('data-mode')) {
      try {
        env = getValue();
      } catch (err) {
        toast(err.message, 'err');
        return;
      }
      textMode = !textMode;
      render();
    }
  };
  container.addEventListener('click', onClick);
  modeSlot?.addEventListener('click', onClick);

  function getValue() {
    return textMode ? parseDotenv($('textarea', container).value) : readRows();
  }

  render();
  return { getValue };
}
