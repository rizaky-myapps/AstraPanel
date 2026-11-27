import { api } from '../api.js';
import { $, html, icon, setHTML, tip } from '../ui.js';

const pad = (n) => String(n).padStart(2, '0');
const DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

export function renderLogin(root, { setupRequired, onSuccess }) {
  setHTML(
    root,
    html`<div class="auth">
      <div class="auth-glow" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="auth-waves" aria-hidden="true">
        <svg class="waves" viewBox="0 24 150 28" preserveAspectRatio="none" focusable="false">
          <defs><path id="auth-wave" d="M-160 44c30 0 58-18 88-18s58 18 88 18 58-18 88-18 58 18 88 18v44h-352z" /></defs>
          <g class="wave-layers">
            <use href="#auth-wave" x="48" y="0" />
            <use href="#auth-wave" x="48" y="3" />
            <use href="#auth-wave" x="48" y="5" />
            <use href="#auth-wave" x="48" y="7" />
          </g>
        </svg>
      </div>
      <div class="lock-clock" aria-hidden="true">
        <div class="desk-time" id="lock-time">--:--</div>
        <div class="desk-date" id="lock-date"></div>
      </div>
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

  // Horloge de l'écran de connexion (s'arrête quand on quitte cet écran)
  const time = $('#lock-time', root);
  const date = $('#lock-date', root);
  const tick = () => {
    if (!time.isConnected) return;
    const now = new Date();
    time.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const d = DATE_FORMAT.format(now);
    date.textContent = d.charAt(0).toUpperCase() + d.slice(1);
    setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
  };
  tick();

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
