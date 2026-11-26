import { api } from '../api.js';
import { $, html, icon, setHTML, tip } from '../ui.js';

export function renderLogin(root, { setupRequired, onSuccess }) {
  setHTML(
    root,
    html`<div class="auth">
      <form class="auth-card" novalidate>
        <div class="brand">${icon('logo')}<span>Astra<b>Panel</b></span></div>
        ${setupRequired ? html`<p class="lead">Bienvenue ! Créez le compte administrateur du panel.</p>` : ''}
        ${setupRequired
          ? html`<div class="field">
              <label for="token">Jeton d'installation ${tip(html`Affiché à la fin de l'installation. Pour le retrouver, sur la machine : <code>sudo cat /opt/astrapanel/data/setup-token</code>`)}</label>
              <input id="token" name="token" type="text" class="mono" autocomplete="off" spellcheck="false" />
            </div>`
          : ''}
        <div class="field">
          <label for="username">Nom d'utilisateur</label>
          <input id="username" name="username" type="text" autocomplete="username" spellcheck="false" />
        </div>
        <div class="field">
          <label for="password">Mot de passe ${setupRequired ? tip('8 caractères minimum.') : ''}</label>
          <input id="password" name="password" type="password" autocomplete="${setupRequired ? 'new-password' : 'current-password'}" />
        </div>
        ${setupRequired
          ? html`<div class="field">
              <label for="confirm">Confirmation</label>
              <input id="confirm" name="confirm" type="password" autocomplete="new-password" />
            </div>`
          : ''}
        <div class="error-text"></div>
        <button class="btn btn-primary btn-block" type="submit">${setupRequired ? 'Créer le compte' : 'Se connecter'}</button>
      </form>
    </div>`,
  );

  const form = $('form', root);
  const error = $('.error-text', form);
  form.querySelector('input').focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    error.textContent = '';
    if (setupRequired && values.password !== values.confirm) {
      error.textContent = 'Les mots de passe ne correspondent pas';
      return;
    }
    const button = $('[type=submit]', form);
    button.disabled = true;
    try {
      const { user } = setupRequired ? await api.post('/auth/setup', values) : await api.post('/auth/login', values);
      onSuccess(user);
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });
}
