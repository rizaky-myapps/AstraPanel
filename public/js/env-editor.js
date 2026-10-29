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
 * Retourne { getValue() } qui lève une erreur si la saisie est invalide.
 */
export function envEditor(container, initial = {}) {
  let textMode = false;
  let env = { ...initial };

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
    setHTML(
      container,
      html`<div class="row" style="margin-bottom:12px">
          <span class="hint">Accessibles dans votre code via <code>process.env.NOM</code>.</span>
          <span class="spacer"></span>
          <button type="button" class="btn btn-ghost btn-sm" data-mode>${icon(textMode ? 'sliders' : 'file')} ${textMode ? 'Mode tableau' : 'Mode texte (.env)'}</button>
        </div>
        ${textMode
          ? html`<textarea class="mono" rows="10" spellcheck="false" placeholder="DISCORD_TOKEN=votre_token">${toDotenv(env)}</textarea>
              <div class="hint" style="margin-top:6px">Une variable par ligne, au format <code>NOM=valeur</code>. Vous pouvez coller un fichier .env.</div>`
          : html`<div class="kv-rows">${entries.length ? entries.map(([k, v]) => row(k, v)) : row()}</div>
              <button type="button" class="btn btn-sm" data-add>${icon('plus')} Ajouter une variable</button>`}`,
    );
  }

  container.addEventListener('click', (e) => {
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
  });

  function getValue() {
    return textMode ? parseDotenv($('textarea', container).value) : readRows();
  }

  render();
  return { getValue };
}
