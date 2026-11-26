import { api, qs, sendBlob } from '../api.js';
import { isAdmin, state } from '../state.js';
import { helpHref } from './help.js';
import { clearCacheAndReload, openRebootOverlay, openUpdateOverlay } from '../update-overlay.js';
import {
  $,
  ROLE_LABEL,
  avatar,
  confirmDialog,
  copyText,
  formatBytes,
  formatDate,
  formatDuration,
  formatLogTime,
  formatTime,
  html,
  icon,
  modal,
  pageHero,
  routingWarnings,
  setHTML,
  tip,
  toast,
  toggle,
  withBusy,
} from '../ui.js';

const TABS = [
  { id: 'compte', label: 'Mon compte', icon: 'user' },
  { id: 'utilisateurs', label: 'Utilisateurs', icon: 'users', admin: true },
  { id: 'mises-a-jour', label: 'Mises à jour', icon: 'arrowUpCircle', admin: true },
  { id: 'tunnel', label: 'Tunnel Cloudflare', icon: 'cloud', admin: true },
  { id: 'general', label: 'Général', icon: 'sliders', admin: true },
  { id: 'hardware', label: 'Hardware', icon: 'cpu', admin: true },
  { id: 'journal', label: 'Journal', icon: 'clock', admin: true },
];

const short = (sha) => (sha ? sha.slice(0, 7) : '—');
const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

const heroUser = () => html`${avatar(state.user, 'xs')} ${state.user.username}`;

export function renderSettings(view, page, tab = 'compte', arg = '') {
  const tabs = TABS.filter((t) => !t.admin || isAdmin());
  if (!tabs.some((t) => t.id === tab)) tab = 'compte';
  const root = document.createElement('div');
  view.replaceChildren(root);
  setHTML(
    root,
    html`${pageHero({
        icon: 'sliders',
        title: 'Paramètres',
        info: 'Votre compte et, pour les administrateurs : les utilisateurs, les mises à jour, le tunnel Cloudflare, les réglages du panel, la machine et le journal d’activité.',
        meta: html`<span class="desk-pill" id="hero-user">${heroUser()}</span><span class="desk-pill">${icon(state.user.role === 'admin' ? 'shield' : 'user')} ${ROLE_LABEL[state.user.role]}</span>`,
      })}
      ${tabs.length > 1 ? html`<nav class="tabs">${tabs.map((t) => html`<a href="#/settings/${t.id}" class="${t.id === tab ? 'active' : ''}">${icon(t.icon)} ${t.label}</a>`)}</nav>` : ''}
      <div id="settings-tab"></div>`,
  );
  // pseudo ou photo modifiés depuis « Mon compte » : le bandeau suit
  const onUser = () => {
    const pill = $('#hero-user', root);
    if (pill) setHTML(pill, heroUser());
  };
  window.addEventListener('astra:user', onUser);
  page.onCleanup(() => window.removeEventListener('astra:user', onUser));
  const el = $('#settings-tab', root);
  const renderers = { compte: accountTab, utilisateurs: usersTab, 'mises-a-jour': updateTab, tunnel: tunnelTab, general: generalTab, hardware: hardwareTab, journal: journalTab };
  return Promise.resolve(renderers[tab](el, page, arg)).catch((err) => {
    if (page.active) setHTML(el, html`<div class="alert err">${icon('alert')}<div>${err.message}</div></div>`);
  });
}

// ---- Mon compte ----------------------------------------------------------------
const ACTIVITY_ICONS = { compte: 'user', application: 'box', fichiers: 'folder', tunnel: 'cloud', machine: 'server', panel: 'sliders' };
const DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

// Force d'un mot de passe (indication, pas une règle) : longueur et variété des caractères
export function passwordStrength(pw) {
  if (!pw) return null;
  if (pw.length < 8) return { pct: 18, label: 'Trop court : 8 caractères minimum', cls: 'err' };
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length;
  const score = variety + (pw.length >= 12 ? 1 : 0) + (pw.length >= 16 ? 1 : 0);
  if (score <= 2) return { pct: 38, label: 'Faible', cls: 'warn' };
  if (score <= 3) return { pct: 66, label: 'Correct', cls: '' };
  return { pct: 100, label: 'Solide', cls: 'ok' };
}

// Le compte a changé (pseudo, photo) : la barre latérale et les autres pages se mettent à jour
function setMe(user) {
  state.user = { ...state.user, ...user };
  window.dispatchEvent(new Event('astra:user'));
}

// Recadrage de la photo : carré de 256 px, image déplaçable à la souris ou au doigt, zoom.
async function photoEditor(canvas, zoomInput, file) {
  let img;
  try {
    img = await createImageBitmap(file);
  } catch {
    throw new Error('Image illisible : choisissez une photo PNG, JPEG, WebP ou GIF');
  }
  const SIZE = canvas.width;
  const g = canvas.getContext('2d');
  const base = SIZE / Math.min(img.width, img.height);
  let zoom = 1;
  let cx = img.width / 2;
  let cy = img.height / 2;
  const draw = () => {
    const scale = base * zoom;
    const half = SIZE / 2 / scale;
    cx = Math.min(Math.max(cx, half), img.width - half);
    cy = Math.min(Math.max(cy, half), img.height - half);
    g.clearRect(0, 0, SIZE, SIZE);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, cx - half, cy - half, half * 2, half * 2, 0, 0, SIZE, SIZE);
  };
  let drag = null;
  canvas.onpointerdown = (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    const ratio = SIZE / canvas.getBoundingClientRect().width / (base * zoom);
    cx -= (e.clientX - drag.x) * ratio;
    cy -= (e.clientY - drag.y) * ratio;
    drag = { x: e.clientX, y: e.clientY };
    draw();
  };
  canvas.onpointerup = () => {
    drag = null;
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    zoom = Math.min(4, Math.max(1, zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    zoomInput.value = zoom;
    draw();
  };
  zoomInput.value = 1;
  zoomInput.oninput = () => {
    zoom = Number(zoomInput.value);
    draw();
  };
  draw();
  return {
    // WebP si le navigateur sait l'écrire, sinon PNG
    toBlob: () => new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9)),
    close: () => img.close?.(),
  };
}

async function accountTab(el, page) {
  const [info, activity] = await Promise.all([api.get('/account'), api.get('/account/activity')]);
  if (!page.active) return;
  setMe(info.user);
  const u = state.user;
  const root = document.createElement('div');
  el.replaceChildren(root);
  const redraw = () => accountTab(el, page).catch((err) => toast(err.message, 'err'));
  const logins = activity.entries.filter((e) => e.label === 'Connexion');
  const failed = activity.entries.filter((e) => e.failed);

  setHTML(
    root,
    html`<div class="stack">
      <section class="profile-hero">
        <div class="profile-photo">
          ${avatar(u, 'xl')}
          <button type="button" class="profile-photo-btn" data-pick title="Changer la photo de profil" aria-label="Changer la photo de profil">${icon('camera')}</button>
        </div>
        <div class="profile-id">
          <h2>${u.username}</h2>
          <div class="desk-pills">
            <span class="desk-pill">${icon(u.role === 'admin' ? 'shield' : 'user')} ${ROLE_LABEL[u.role]} ${tip(
              u.role === 'admin'
                ? 'Accès complet : toutes les applications, utilisateurs, mises à jour, tunnel, stockage, machine et journal.'
                : 'Vous voyez les applications que vous avez créées et celles auxquelles on vous a donné accès (onglet « Utilisateurs » de chaque application). Les paramètres du panel sont réservés aux administrateurs.',
            )}</span>
            ${u.createdAt ? html`<span class="desk-pill">${icon('clock')} Membre depuis le ${DAY_FORMAT.format(new Date(u.createdAt))}</span>` : ''}
            <span class="desk-pill">${icon('box')} ${info.apps.owned} application${info.apps.owned > 1 ? 's' : ''} créée${info.apps.owned > 1 ? 's' : ''}</span>
            ${info.apps.shared ? html`<span class="desk-pill">${icon('users')} ${info.apps.shared} partagée${info.apps.shared > 1 ? 's' : ''} avec vous</span>` : ''}
          </div>
        </div>
        <div class="profile-actions">
          <button type="button" class="btn btn-glass" data-pick>${icon('camera')} ${u.avatar ? 'Changer la photo' : 'Ajouter une photo'}</button>
          ${u.avatar ? html`<button type="button" class="btn btn-ghost" data-remove-photo>${icon('trash')} Retirer</button>` : ''}
          ${tip('La photo s’affiche dans le panneau latéral, sur le tableau de bord et dans les listes d’utilisateurs. Elle est recadrée en carré : faites-la glisser pour choisir la partie visible, et zoomez avec le curseur ou la molette.')}
        </div>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="hidden" id="photo-file" />
      </section>

      <div class="account-cols">
        <div class="account-col">
        <form class="card" id="name-form" autocomplete="off">
          <div class="card-header"><h2>${icon('atSign')} Pseudo ${tip('Votre pseudo s’affiche partout dans le panel et sert à vous connecter. 3 à 32 caractères : lettres, chiffres, . _ -')}</h2></div>
          <div class="card-body">
            <div class="field"><label for="acc-name">Nouveau pseudo</label><input id="acc-name" type="text" name="username" value="${u.username}" spellcheck="false" autocapitalize="off" maxlength="32" required /></div>
            <div class="field"><label for="acc-name-pw">Mot de passe ${tip('Confirme que c’est bien vous.')}</label><input id="acc-name-pw" type="password" name="password" autocomplete="current-password" required /></div>
          </div>
          <div class="card-foot"><button class="btn btn-primary" type="submit">${icon('check')} Changer de pseudo</button></div>
        </form>
        <section class="card">
          <div class="card-header"><h2>${icon('devices')} Appareils et connexions ${tip('Déconnecte toutes vos autres sessions : autre navigateur, téléphone, ordinateur prêté… Vous restez connecté ici. Pratique si vous avez oublié de vous déconnecter ailleurs.')}</h2></div>
          <div class="card-body stack-sm">
            <table class="table kv-table compact">
              <tbody>
                <tr><td class="muted">Dernière connexion</td><td>${logins[0] ? html`${formatDate(logins[0].at)} <span class="muted">· ${logins[0].ip || '—'}</span>` : '—'}</td></tr>
                <tr><td class="muted">Connexion précédente</td><td>${logins[1] ? html`${formatDate(logins[1].at)} <span class="muted">· ${logins[1].ip || '—'}</span>` : '—'}</td></tr>
                <tr><td class="muted">Tentatives échouées</td><td>${failed.length
                  ? html`<span class="badge st-crashed">${failed.length}</span> <span class="muted">dernière le ${formatDate(failed[0].at)} · ${failed[0].ip || '—'}</span>`
                  : html`<span class="badge st-running">Aucune</span>`}</td></tr>
              </tbody>
            </table>
            <div class="row"><button type="button" class="btn" data-logout-others>${icon('logout')} Se déconnecter des autres appareils</button></div>
          </div>
        </section>
        </div>
        <div class="account-col">
        <form class="card" id="password-form">
          <div class="card-header"><h2>${icon('key')} Mot de passe ${tip('Changer de mot de passe déconnecte vos autres appareils ; vous restez connecté ici.')}</h2></div>
          <div class="card-body">
            <div class="field"><label for="acc-pw-current">Mot de passe actuel</label><input id="acc-pw-current" type="password" name="current" autocomplete="current-password" required /></div>
            <div class="field">
              <label for="acc-pw-next">Nouveau mot de passe</label>
              <div class="input-group">
                <input id="acc-pw-next" type="password" name="next" autocomplete="new-password" required />
                <button type="button" class="btn btn-ghost btn-icon" data-show-pw title="Afficher les mots de passe" aria-label="Afficher les mots de passe">${icon('eye')}</button>
              </div>
              <div class="pw-meter" id="pw-meter" aria-live="polite"><div class="pw-meter-bar"><i></i></div><span></span></div>
            </div>
            <div class="field"><label for="acc-pw-confirm">Confirmation</label><input id="acc-pw-confirm" type="password" name="confirm" autocomplete="new-password" required /></div>
          </div>
          <div class="card-foot"><button class="btn btn-primary" type="submit">${icon('check')} Changer le mot de passe</button></div>
        </form>

        </div>
      </div>

      <section class="card">
        <div class="card-header"><h2>${icon('activity')} Activité récente ${tip('Vos 20 dernières actions dans le panel, et les tentatives de connexion échouées avec votre pseudo.')}</h2></div>
        ${activity.entries.length
          ? html`<ul class="activity-list">
              ${activity.entries.map(
                (e) => html`<li class="${e.failed ? 'failed' : ''}">
                  <span class="activity-icon">${icon(e.failed ? 'alert' : ACTIVITY_ICONS[e.category] || 'info')}</span>
                  <span class="activity-text"><b>${e.failed ? 'Tentative de connexion échouée' : e.label}</b>${e.app ? html` · <a href="#/apps/${e.app.id}">${e.app.name}</a>` : ''}${e.detail ? html`<span class="muted"> · ${e.detail}</span>` : ''}</span>
                  <span class="activity-meta faint">${formatDate(e.at)}${e.ip ? ` · ${e.ip}` : ''}</span>
                </li>`,
              )}
            </ul>`
          : html`<div class="card-body muted">Aucune activité pour l'instant.</div>`}
      </section>
    </div>`,
  );

  // --- Photo : recadrage dans une fenêtre, puis envoi
  const fileInput = $('#photo-file', root);
  const editPhoto = async (file) => {
    let editor = null;
    const saved = await modal({
      title: 'Photo de profil',
      confirmLabel: 'Enregistrer',
      cls: 'photo-modal',
      body: html`<div class="photo-edit">
        <canvas width="256" height="256" class="photo-canvas" aria-label="Aperçu : faites glisser la photo pour la cadrer"></canvas>
        <label class="photo-zoom">${icon('search')}<input type="range" min="1" max="4" step="0.01" value="1" aria-label="Zoom" /></label>
      </div>`,
      onOpen: async (form) => {
        editor = await photoEditor(form.querySelector('canvas'), form.querySelector('input[type=range]'), file);
      },
      onConfirm: async () => {
        if (!editor) throw new Error('La photo n’est pas encore prête');
        const { user } = await sendBlob('PUT', '/account/avatar', await editor.toBlob());
        return user;
      },
    });
    editor?.close();
    if (saved) {
      setMe(saved);
      toast('Photo de profil enregistrée');
      redraw();
    }
  };
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) editPhoto(file);
  });
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-pick]')) {
      fileInput.value = '';
      fileInput.click();
    }
    const remove = e.target.closest('[data-remove-photo]');
    if (remove) {
      if (!(await confirmDialog('Retirer la photo ?', 'L’initiale de votre pseudo la remplacera.', { confirmLabel: 'Retirer' }))) return;
      await withBusy(remove, async () => {
        const { user } = await api.del('/account/avatar');
        setMe(user);
        toast('Photo de profil retirée');
        redraw();
      });
    }
    const pw = e.target.closest('[data-show-pw]');
    if (pw) {
      const show = pw.dataset.shown !== '1';
      pw.dataset.shown = show ? '1' : '';
      $('#password-form', root).querySelectorAll('input[name=next], input[name=confirm]').forEach((i) => (i.type = show ? 'text' : 'password'));
      setHTML(pw, icon(show ? 'eyeOff' : 'eye'));
      pw.title = show ? 'Masquer les mots de passe' : 'Afficher les mots de passe';
    }
    const others = e.target.closest('[data-logout-others]');
    if (others) {
      if (!(await confirmDialog('Se déconnecter des autres appareils ?', 'Toutes vos autres sessions seront fermées. Vous restez connecté ici.', { confirmLabel: 'Déconnecter' }))) return;
      await withBusy(others, async () => {
        await api.post('/account/logout-others');
        toast('Vos autres appareils ont été déconnectés');
        redraw();
      });
    }
  });

  // --- Pseudo
  $('#name-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const values = Object.fromEntries(new FormData(form));
    withBusy($('[type=submit]', form), async () => {
      const { user } = await api.patch('/account', { username: values.username.trim(), password: values.password });
      setMe(user);
      toast(`Pseudo modifié : connectez-vous désormais avec « ${user.username} »`);
      redraw();
    });
  });

  // --- Mot de passe
  const meter = $('#pw-meter', root);
  $('#password-form [name=next]', root).addEventListener('input', (e) => {
    const s = passwordStrength(e.target.value);
    meter.className = `pw-meter ${s ? s.cls : ''} ${s ? 'shown' : ''}`;
    meter.querySelector('i').style.width = `${s ? s.pct : 0}%`;
    meter.querySelector('span').textContent = s ? s.label : '';
  });
  $('#password-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const values = Object.fromEntries(new FormData(form));
    if (values.next !== values.confirm) {
      toast('Les mots de passe ne correspondent pas', 'err');
      return;
    }
    withBusy($('[type=submit]', form), async () => {
      await api.post('/auth/password', { current: values.current, next: values.next });
      form.reset();
      toast('Mot de passe modifié. Vos autres appareils ont été déconnectés.');
      redraw();
    });
  });
}

// ---- Utilisateurs ----------------------------------------------------------------
const roleSelect = (name, value) =>
  html`<select name="${name}">${Object.entries(ROLE_LABEL).map(([v, label]) => html`<option value="${v}" ${v === value ? 'selected' : ''}>${label}</option>`)}</select>`;

async function usersTab(el, page) {
  const users = await api.get('/users');
  if (!page.active) return;
  setHTML(
    el,
    html`<div class="card">
      <div class="card-header">
        <h2>${icon('users')} Utilisateurs ${tip(
          html`<b>Administrateur</b> : accès complet (toutes les applications, paramètres, utilisateurs, mises à jour, tunnel, stockage, machine, journal, suppression d'applications).<br /><br />
            <b>Utilisateur</b> : voit et gère uniquement les applications qu'il a créées et celles auxquelles on lui a donné accès (onglet « Utilisateurs » de chaque application), ainsi que son mot de passe.<br /><br />
            Il reste toujours au moins un administrateur.`,
        )}</h2>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-primary" data-add>${icon('plus')} Ajouter un utilisateur</button>
      </div>
      <div class="fm-scroll">
        <table class="table users-table">
          <thead><tr><th>Nom</th><th>Grade</th><th class="hide-sm">Créé le</th><th></th></tr></thead>
          <tbody>
            ${users.map(
              (u) => html`<tr data-id="${u.id}" data-name="${u.username}">
                <td><div class="user-cell">${avatar(u)}<span class="truncate">${u.username}${u.id === state.user.id ? html` <span class="faint">(vous)</span>` : ''}</span></div></td>
                <td class="role-cell">${roleSelect('role', u.role)}</td>
                <td class="muted hide-sm">${formatDate(u.createdAt)}</td>
                <td>
                  <div class="file-actions">
                    <a class="btn btn-ghost btn-sm btn-icon" title="Voir son activité" aria-label="Voir l'activité de ${u.username}" href="#/settings/journal/${u.id}">${icon('clock')}</a>
                    <button class="btn btn-ghost btn-sm btn-icon" title="Changer le pseudo" data-rename>${icon('atSign')}</button>
                    <button class="btn btn-ghost btn-sm btn-icon" title="Définir un nouveau mot de passe" data-password>${icon('key')}</button>
                    ${u.id === state.user.id ? '' : html`<button class="btn btn-ghost btn-sm btn-icon" title="Supprimer" data-del>${icon('trash')}</button>`}
                  </div>
                </td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </div>`,
  );

  el.addEventListener('change', (e) => {
    if (!e.target.matches('select[name=role]')) return;
    const row = e.target.closest('tr');
    const select = e.target;
    withBusy(select, async () => {
      try {
        await api.patch(`/users/${row.dataset.id}`, { role: select.value });
        toast(`${row.dataset.name} est maintenant ${ROLE_LABEL[select.value].toLowerCase()}`);
        if (row.dataset.id === state.user.id && select.value !== 'admin') location.reload();
      } catch (err) {
        rerender();
        throw err;
      }
    });
  });

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-add]')) {
      const created = await modal({
        title: 'Nouvel utilisateur',
        confirmLabel: 'Créer',
        body: html`<div class="field"><label>Nom d'utilisateur</label><input type="text" name="username" autocomplete="off" /></div>
          <div class="field"><label>Mot de passe ${tip('8 caractères minimum.')}</label><input type="password" name="password" autocomplete="new-password" /></div>
          <div class="field"><label>Grade</label>${roleSelect('role', 'user')}</div>`,
        onConfirm: (values) => api.post('/users', values),
      });
      if (created) {
        toast(`Utilisateur ${created.username} créé`);
        rerender();
      }
      return;
    }
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    if (e.target.closest('[data-rename]')) {
      const renamed = await modal({
        title: `Nouveau pseudo pour ${row.dataset.name}`,
        confirmLabel: 'Renommer',
        body: html`<div class="field"><label>Pseudo ${tip('Il sert aussi à se connecter : prévenez la personne. 3 à 32 caractères : lettres, chiffres, . _ -')}</label><input type="text" name="username" value="${row.dataset.name}" autocomplete="off" spellcheck="false" /></div>`,
        onConfirm: (values) => api.patch(`/users/${row.dataset.id}`, { username: values.username.trim() }),
      });
      if (renamed) {
        toast(`${row.dataset.name} s’appelle maintenant ${renamed.username}`);
        if (renamed.id === state.user.id) {
          state.user = { ...state.user, username: renamed.username };
          window.dispatchEvent(new Event('astra:user'));
        }
        rerender();
      }
      return;
    }
    if (e.target.closest('[data-password]')) {
      const done = await modal({
        title: `Nouveau mot de passe pour ${row.dataset.name}`,
        confirmLabel: 'Enregistrer',
        body: html`<div class="field"><label>Mot de passe ${tip('8 caractères minimum. L’utilisateur sera déconnecté de ses sessions en cours.')}</label><input type="password" name="password" autocomplete="new-password" /></div>`,
        onConfirm: (values) => api.patch(`/users/${row.dataset.id}`, { password: values.password }),
      });
      if (done) toast('Mot de passe modifié');
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!(await confirmDialog('Supprimer cet utilisateur ?', `${row.dataset.name} ne pourra plus se connecter.`, { danger: true, confirmLabel: 'Supprimer' }))) return;
      await withBusy(del, async () => {
        await api.del(`/users/${row.dataset.id}`);
        rerender();
      });
    }
  });
}

// ---- Mises à jour ------------------------------------------------------------------
async function updateTab(el, page) {
  let info = await api.get('/update');
  if (!page.active) return;
  let logTimer = null;
  let refreshTimer = null;
  page.onCleanup(() => {
    clearTimeout(logTimer);
    clearInterval(refreshTimer);
  });

  const inMinutes = (ts) => {
    const min = Math.max(0, Math.round((ts - Date.now()) / 60_000));
    return min < 1 ? 'dans moins d’une minute' : `dans ${min} min`;
  };

  const draw = () => {
    const inst = info.installed;
    const every = Math.round((info.interval || 300_000) / 60_000);
    setHTML(
      el,
      html`<div class="stack">
        <div class="card">
          <div class="card-header"><h2>${icon('arrowUpCircle')} Mises à jour d'AstraPanel ${tip(html`Le panel lit la version publiée sur la branche <code>${info.branch}</code> du dépôt GitHub, automatiquement toutes les 5 minutes.`)}</h2></div>
          <div class="card-body">
            ${!inst ? html`<div class="alert warn">${icon('alert')}<div>Ce panel n'a pas été installé depuis un clone Git : la mise à jour automatique est indisponible. Réinstallez-le avec <code>install.sh</code>.</div></div>` : ''}
            ${inst && !info.updater
              ? html`<div class="alert warn">${icon('alert')}<div>Le service de mise à jour n'est pas encore installé sur la machine. Faites une dernière mise à jour en SSH, en réinstallant la dernière version (tutoriel, étape 5 : <code>git clone</code> puis <code>sudo ./install.sh</code>) : les suivantes se feront d'ici.</div></div>`
              : ''}
            ${info.error ? html`<div class="alert err">${icon('alert')}<div>${info.error}</div></div>` : ''}
            ${inst
              ? html`<table class="table kv-table">
                  <tbody>
                    <tr><td class="muted">Version installée</td><td><b>${inst.version}</b> <span class="muted">· commit <code>${short(inst.commit)}</code></span></td></tr>
                    <tr><td class="muted">Dernière version publiée</td><td>${info.latestVersion ? html`<b>${info.latestVersion}</b> <span class="muted">· branche <code>${info.branch}</code></span>` : html`<span class="muted">pas encore vérifiée</span>`}</td></tr>
                    ${inst.installedAt ? html`<tr><td class="muted">Installée le</td><td>${formatDate(inst.installedAt)}</td></tr>` : ''}
                    <tr><td class="muted">Dépôt</td><td class="mono truncate">${inst.repo || '—'}</td></tr>
                    <tr><td class="muted">Vérification automatique</td><td>toutes les ${every} minutes<span class="muted">${info.checking ? ' · vérification en cours…' : ''}${!info.checking && info.lastCheck ? ` · dernière : ${formatTime(info.lastCheck)}` : ''}${!info.checking && info.nextCheck > Date.now() ? ` · prochaine : ${inMinutes(info.nextCheck)}` : ''}</span></td></tr>
                  </tbody>
                </table>`
              : ''}
          </div>
          ${inst
            ? html`<div class="card-foot">
                <button class="btn" data-check>${icon('refresh')} Vérifier maintenant</button>
              </div>`
            : ''}
        </div>

        ${info.available
          ? html`<div class="card highlight-ok">
              <div class="card-header">
                <h2>${icon('sparkles')} Nouvelle version disponible : ${info.latestVersion} ${tip('Pendant la mise à jour (1 à 3 minutes), le panel redémarre et vos applications sont relancées automatiquement.')}</h2>
                <span class="spacer"></span>
                <code>${short(info.latestCommit)}</code>
              </div>
              ${info.commits.length
                ? html`<div class="card-body">
                    <ul class="commits">
                      ${info.commits.map((c) => html`<li><span>${c.message}</span><span class="muted"> — ${c.author}${c.date ? `, ${formatDate(c.date)}` : ''}</span></li>`)}
                    </ul>
                  </div>`
                : ''}
              <div class="card-foot">
                <button class="btn btn-primary" data-apply ${info.updater && !info.pending ? '' : 'disabled'}>${icon('arrowUpCircle')} Mettre à jour vers la ${info.latestVersion}</button>
              </div>
            </div>`
          : inst && info.latestVersion && !info.error
            ? html`<div class="alert ok">${icon('check')}<div>Le panel est à jour : version ${inst.version}.</div></div>`
            : ''}

        <div class="card ${info.run || info.pending ? '' : 'hidden'}" id="run-card">
          <div class="card-header"><h2>${icon('terminal')} Dernière mise à jour</h2><span class="spacer"></span><span id="run-state"></span></div>
          <pre class="code update-log" id="update-log"></pre>
        </div>
      </div>`,
    );

    $('[data-check]', el)?.addEventListener('click', (e) =>
      withBusy(e.target.closest('button'), async () => {
        info = await api.post('/update/check');
        if (!page.active) return;
        draw();
        if (!info.error) toast(info.available ? `La version ${info.latestVersion} est disponible` : 'Le panel est à jour', info.available ? 'info' : 'ok');
      }),
    );
    $('[data-apply]', el)?.addEventListener('click', async (e) => {
      if (!(await confirmDialog(`Mettre à jour vers la version ${info.latestVersion} ?`, 'Le panel va télécharger la nouvelle version puis redémarrer. Cela prend 1 à 3 minutes.', { confirmLabel: 'Mettre à jour' }))) return;
      await withBusy(e.target.closest('button'), async () => {
        await api.post('/update/apply');
        openUpdateOverlay({ target: info.latestVersion, current: info.installed?.version });
        startedAt = Date.now();
        $('#run-card', el).classList.remove('hidden');
        followLog();
      });
    });
    if (info.run || info.pending) followLog();
  };

  // Les vérifications automatiques du serveur apparaissent sans recharger la page.
  refreshTimer = setInterval(async () => {
    if (startedAt || info.pending) return; // une mise à jour est en cours : le journal a la main
    const next = await api.get('/update').catch(() => null);
    if (!next || !page.active) return;
    const changed = ['latestVersion', 'available', 'error', 'checking', 'lastCheck'].some((k) => next[k] !== info[k]);
    info = next;
    if (changed) draw();
  }, 30_000);

  // Suit le journal de la mise à jour ; le panel redémarre en cours de route (requêtes en échec un moment).
  let startedAt = 0;
  async function followLog() {
    clearTimeout(logTimer);
    const stateEl = $('#run-state', el);
    const logEl = $('#update-log', el);
    if (!stateEl) return;
    try {
      const { log, run } = await api.get('/update/log');
      if (!page.active) return;
      logEl.textContent = log || 'En attente du service de mise à jour…';
      logEl.scrollTop = logEl.scrollHeight;
      const fresh = run && run.at >= startedAt - 5000;
      if (run?.state === 'done' && startedAt && fresh) {
        stateEl.innerHTML = String(html`<span class="badge st-running">Terminée</span>`);
        toast('Mise à jour terminée : rechargement du panel…');
        setTimeout(clearCacheAndReload, 2000);
        return;
      }
      if (run?.state === 'failed') {
        stateEl.innerHTML = String(html`<span class="badge st-crashed">Échec</span>`);
        return;
      } else if (run?.state === 'done') {
        stateEl.innerHTML = String(html`<span class="badge plain">${formatDate(run.at)}</span>`);
        if (!startedAt) return;
      } else {
        stateEl.innerHTML = String(html`<span class="badge st-busy">${run?.message || 'En attente…'}</span>`);
      }
    } catch {
      stateEl.innerHTML = String(html`<span class="badge st-restarting">Redémarrage du panel…</span>`);
    }
    if (page.active) logTimer = setTimeout(followLog, 2000);
  }

  draw();
}

// ---- Tunnel Cloudflare ----------------------------------------------------------------
async function tunnelTab(el, page) {
  let status = await api.get('/tunnel');
  if (!page.active) return;
  // Mode affiché : « géré depuis le site » seulement si un jeton de tunnel y est enregistré ; sinon le mode
  // recommandé (géré depuis le panel), y compris pendant sa configuration.
  const initialMode = (st) => (st.mode === 'token' && st.token ? 'token' : 'api');
  let mode = initialMode(status);
  let accounts = null;
  let pollTimer = null;
  let source = null;
  page.onCleanup(() => {
    clearTimeout(pollTimer);
    source?.close();
  });

  const connection = () => {
    if (!status.running) return html`<span class="badge">Arrêté</span>`;
    if (status.ready?.readyConnections > 0) return html`<span class="badge st-running">Connecté · ${status.ready.readyConnections} liaison(s)</span>`;
    return html`<span class="badge st-restarting">Connexion…</span>`;
  };
  const isReady = () => (status.mode === 'api' ? Boolean(status.api.tunnelId) : Boolean(status.token));

  // cloudflared : « Mettre à jour » seulement si une version plus récente existe, sinon « Vérifier les mises à jour »
  function cloudflaredRow() {
    const latest = status.latest;
    let info;
    let button;
    if (!status.binary) {
      info = 'Non installé : il sera téléchargé automatiquement à la création du tunnel.';
      button = html`<button class="btn btn-sm btn-primary" data-install>${icon('download')} Installer cloudflared</button>`;
    } else {
      info = `Version ${status.version || 'inconnue'}${status.binary === 'cloudflared' ? ' (installée sur le système)' : ''}`;
      if (status.updateAvailable) {
        info += ` · la version ${latest.version} est disponible`;
        button = html`<button class="btn btn-sm btn-primary" data-install>${icon('download')} Mettre à jour vers la ${latest.version}</button>`;
      } else {
        if (latest?.version && !latest.error) info += ' · à jour';
        button = html`<button class="btn btn-sm" data-check-update>${icon('refresh')} Vérifier les mises à jour</button>`;
      }
    }
    const checked = latest?.checkedAt ? `Dernière vérification à ${formatTime(latest.checkedAt)}` : '';
    return html`<div class="row">
      <div class="state-text">
        <div class="label">cloudflared</div>
        <div class="hint">${info}</div>
        ${latest?.error ? html`<div class="hint warn-text">${latest.error}</div>` : checked ? html`<div class="hint faint">${checked}</div>` : ''}
      </div>
      <span class="spacer"></span>
      ${button}
    </div>`;
  }

  function stateCard() {
    const ready = isReady();
    return html`<div class="card-header"><h2>${icon('server')} État</h2><span class="spacer"></span><span id="conn-badge">${connection()}</span></div>
      <div class="card-body tunnel-status">
        ${cloudflaredRow()}
        <div class="row">
          <div class="state-text">
            <div class="label">Tunnel actif ${tip(ready ? 'Le tunnel démarre automatiquement avec le panel.' : 'Configurez d’abord un tunnel ci-dessous (« Mode de gestion ») pour pouvoir l’activer.')}</div>
          </div>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm" data-restart ${status.running ? '' : 'disabled'}>${icon('restart')} Redémarrer</button>
          <label class="check inline">${toggle('enabled', status.enabled, { id: 'tunnel-enabled', disabled: !ready || !status.binary, label: 'Tunnel actif' })}</label>
        </div>
      </div>`;
  }

  function draw() {
    setHTML(
      el,
      html`<div class="stack">
        <div class="card" id="state-card">${stateCard()}</div>

        <div class="card">
          <div class="card-header">
            <h2>${icon('sliders')} Mode de gestion ${tip(
              html`Le <b>tunnel Cloudflare</b> met vos sites en ligne sur votre nom de domaine, en HTTPS, <b>sans ouvrir de port sur votre box</b>
                (il fonctionne même sans IPv4 publique) : la machine garde une connexion sortante vers Cloudflare, qui lui transmet les visites.<br /><br />
                Avant de commencer, votre nom de domaine doit être ajouté à votre compte Cloudflare (offre gratuite) et marqué « Active » :
                <a href="${helpHref('cloudflare', '3-ajouter-votre-nom-de-domaine-à-cloudflare')}">étape 3 du tutoriel</a>.`,
            )}</h2>
            <span class="spacer"></span>
            <a class="btn btn-ghost btn-sm" href="${helpHref('cloudflare')}">${icon('book')} Tutoriel</a>
          </div>
          <div class="card-body">
            <div class="choices">
              <button type="button" class="choice ${mode === 'api' ? 'selected' : ''}" data-mode="api">
                <div class="t">${icon('sparkles')} Géré depuis le panel</div>
                <div class="d">Recommandé. Avec un jeton d'API, le panel crée le tunnel et les enregistrements DNS : ajoutez un domaine à une application, il est en ligne.</div>
              </button>
              <button type="button" class="choice ${mode === 'token' ? 'selected' : ''}" data-mode="token">
                <div class="t">${icon('globe')} Géré depuis le site Cloudflare</div>
                <div class="d">Vous créez le tunnel et ses adresses publiques dans le tableau de bord Cloudflare ; le panel fait seulement tourner le tunnel.</div>
              </button>
            </div>
          </div>
          <div class="card-body" id="mode-body" style="padding-top:0"></div>
        </div>

        <div class="card">
          <div class="card-header"><h2>${icon('terminal')} Journal du tunnel</h2></div>
          <div class="console small"><div class="console-output" id="tunnel-log"></div></div>
        </div>

        ${isReady() || status.api.connected
          ? html`<div class="row"><span class="spacer"></span><button class="btn btn-danger btn-sm" data-reset>${icon('trash')} Supprimer la configuration du tunnel</button></div>`
          : ''}
      </div>`,
    );
    drawMode();
    openLog();
  }

  // Libellé d'un bouton du site Cloudflare (en anglais à l'écran), avec sa traduction
  const ui = (label, fr = '') => html`<b class="ui-label">${label}</b>${fr ? html` <span class="muted">(${fr})</span>` : ''}`;

  const siteLinks = () => {
    const sites = state.apps.filter((x) => x.port);
    return sites.length
      ? html`<div class="row site-links">${sites.map((x) => html`<a class="btn btn-sm" href="#/apps/${x.id}/settings">${icon('globe')} ${x.name}${x.domains?.length ? ` · ${x.domains[0]}` : ' : ajouter un domaine'}</a>`)}</div>`
      : html`<p class="hint">Vous n'avez pas encore de site : créez-en un avec <a href="#/new">Nouvelle application</a>.</p>`;
  };

  const appsTable = () =>
    html`<table class="table compact">
      <thead><tr><th>Site</th><th>À indiquer dans « Service URL »</th></tr></thead>
      <tbody>
        ${state.apps.filter((a) => a.port).length
          ? state.apps.filter((a) => a.port).map((a) => html`<tr><td>${a.name}</td><td><code>http://localhost:${a.port}</code></td></tr>`)
          : html`<tr><td colspan="2" class="muted">Aucun site pour l'instant.</td></tr>`}
        <tr><td>Panel AstraPanel</td><td><code>http://localhost:${location.port || '8080'}</code></td></tr>
      </tbody>
    </table>`;

  function drawMode() {
    const box = $('#mode-body', el);
    if (mode === 'token') {
      setHTML(
        box,
        html`${status.mode === 'token' && status.token
            ? html`<div class="alert info">${icon('check')}<div>Tunnel configuré : <code>${status.token.tunnelId}</code></div></div>`
            : ''}
          <ol class="stepper">
            <li>
              <div class="stepper-title">Créer le tunnel sur le site de Cloudflare</div>
              <ol class="guide">
                <li>Ouvrez <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener">dash.cloudflare.com</a> et connectez-vous.</li>
                <li>Dans le menu de gauche, cliquez sur ${ui('Networking', 'Réseau')}, puis sur ${ui('Tunnels')}.</li>
                <li>Cliquez sur ${ui('Create a tunnel', 'créer un tunnel')}, donnez-lui un nom (par exemple <code>mon-serveur</code>), puis cliquez sur ${ui('Create Tunnel')}.</li>
              </ol>
            </li>
            <li>
              <div class="stepper-title">Donner le jeton du tunnel au panel</div>
              <ol class="guide">
                <li>Cloudflare affiche une page d'installation : choisissez le système ${ui('Debian')}.</li>
                <li>Copiez la commande affichée. Elle ressemble à <code>sudo cloudflared service install eyJhIjoi…</code>. <b>Ne la lancez pas sur la machine</b> : le panel s'en occupe.</li>
                <li>Collez-la dans le champ en bas de cette page, puis cliquez sur <b>Enregistrer et démarrer</b>. L'état en haut de la page passe à « Connecté ».</li>
                <li>Revenez sur Cloudflare : le connecteur apparaît comme connecté. Cliquez sur ${ui('Continue', 'continuer')}.</li>
              </ol>
            </li>
            <li>
              <div class="stepper-title">Publier vos sites</div>
              <ol class="guide">
                <li>Sur Cloudflare, ouvrez votre tunnel (${ui('Networking')} → ${ui('Tunnels')} → nom du tunnel), puis l'onglet ${ui('Routes')}.</li>
                <li>Cliquez sur ${ui('Add route', 'ajouter une route')}, puis sur ${ui('Published application', 'application publiée')}.</li>
                <li>Remplissez ${ui('Subdomain', 'sous-domaine, par exemple blog ; vide pour le domaine seul')}, choisissez votre domaine dans ${ui('Domain', 'domaine')}, et indiquez dans ${ui('Service URL', 'adresse du service')} l'adresse du site donnée dans le tableau ci-dessous.</li>
                <li>Cliquez sur ${ui('Add route')}. Cloudflare crée lui-même l'enregistrement DNS : le site est en ligne en HTTPS.</li>
              </ol>
            </li>
          </ol>
          ${appsTable()}
          <form id="token-form" style="margin-top:16px">
            <div class="field">
              <label>Jeton du tunnel (ou commande complète)</label>
              <textarea name="token" class="mono" rows="3" placeholder="cloudflared service install eyJhIjoi…" spellcheck="false"></textarea>
            </div>
            <div class="row"><span class="spacer"></span><button class="btn btn-primary" type="submit">${icon('save')} Enregistrer et démarrer</button></div>
          </form>`,
      );
      $('#token-form', box).addEventListener('submit', (e) => {
        e.preventDefault();
        const token = e.target.token.value;
        withBusy($('[type=submit]', e.target), async () => {
          if (!status.binary) await api.post('/tunnel/install');
          status = await api.post('/tunnel/token', { token });
          toast('Tunnel enregistré et démarré');
          refresh(true);
        });
      });
      return;
    }

    // Mode API
    const a = status.api;
    const tokenGuide = () => html`<ol class="guide">
        <li>Ouvrez <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">dash.cloudflare.com/profile/api-tokens</a> (menu ${ui('Paramètres utilisateur')} → ${ui('Identifiants API')} → ${ui('Jetons API')}), puis cliquez sur ${ui('Créer un jeton')}.</li>
        <li>Dans ${ui('Nom du jeton')}, écrivez <code>AstraPanel</code>.</li>
        <li>Dans ${ui('Politiques')}, cliquez sur ${ui('Commencer de zéro')} (la ligne marquée <i>Custom</i>). Une politique <b>Zone</b> s'ouvre :
          <ul>
            <li>laissez ${ui('Inclure')} et ${ui('Toutes les zones')} ;</li>
            <li>dépliez la catégorie ${ui('DNS & Zones')} et cochez <b>DNS</b> avec le niveau <b>Modifier</b>, et <b>Zone</b> avec le niveau <b>Lire</b>.</li>
          </ul>
        </li>
        <li>Cliquez sur ${ui('Ajouter une nouvelle politique')} et choisissez le type <b>Compte</b> :
          <ul>
            <li>laissez ${ui('Inclure')} et choisissez votre compte ;</li>
            <li>dans ${ui('Rechercher des groupes d’autorisations…')}, tapez <code>Tunnel</code> et cochez <b>Cloudflare Tunnel</b> avec le niveau <b>Modifier</b>.</li>
          </ul>
        </li>
        <li>Vérifiez les deux politiques : <b>Politique Zone</b> « DNS Write, Zone Read » et <b>Politique Compte</b> « Cloudflare Tunnel Write ».</li>
        <li>${ui('Expiration du jeton')} : choisissez ${ui('Pas d’expiration')} (sinon le panel ne pourra plus publier de domaines à l'échéance). Laissez ${ui('Filtrage des adresses IP client')} vide.</li>
        <li>Cliquez sur ${ui('Continuer vers le résumé')}, validez la création, puis <b>copiez le jeton</b> : il ne sera plus jamais affiché. Collez-le ci-dessous.</li>
      </ol>
      <p class="hint">Tableau de bord Cloudflare en anglais ? ${tip(html`Les mêmes boutons s'appellent <i>Create Token</i>, <i>Custom token</i>, <i>Add more</i>, <i>Continue to summary</i>, et les niveaux <i>Edit</i> / <i>Read</i>.`)}</p>`;
    const apiForm = () => html`<form id="api-form" class="input-group">
        <input type="password" name="apiToken" class="mono" placeholder="${a.connected ? 'Collez le nouveau jeton d’API' : 'Collez ici le jeton d’API'}" autocomplete="off" required />
        <button class="btn ${a.connected ? '' : 'btn-primary'}" type="submit">${a.connected ? 'Remplacer' : 'Connecter'}</button>
      </form>`;
    const setupForm = () => html`<form id="setup-form" class="stack-sm">
        <div class="field">
          <label for="tunnel-account">Compte Cloudflare</label>
          <select id="tunnel-account" name="accountId" ${a.connected ? '' : 'disabled'}>
            ${accounts
              ? accounts.map((x) => html`<option value="${x.id}" ${x.id === a.accountId ? 'selected' : ''}>${x.name}</option>`)
              : a.accountId
                ? html`<option value="${a.accountId}">${a.accountName}</option>`
                : html`<option value="">${a.connected ? 'Chargement des comptes…' : 'Connectez d’abord le jeton (étape 1)'}</option>`}
          </select>
        </div>
        <div class="field">
          <label for="tunnel-name">Nom du tunnel</label>
          <div class="input-group">
            <input type="text" id="tunnel-name" name="name" class="mono" value="${a.tunnelName || `astrapanel-${location.hostname.split('.')[0] || 'serveur'}`}" ${a.connected ? '' : 'disabled'} />
            <button class="btn btn-primary" type="submit" ${a.connected ? '' : 'disabled'}>${a.tunnelId ? 'Relier à nouveau' : 'Créer le tunnel'}</button>
          </div>
        </div>
      </form>`;
    const publishGuide = () => html`<ol class="guide">
        <li>Ouvrez l'application (le site) dans le panel, onglet <b>Paramètres</b>.</li>
        <li>Dans <b>Nom(s) de domaine</b>, écrivez l'adresse voulue : <code>monsite.fr</code>, <code>blog.monsite.fr</code>… (plusieurs, séparées par des virgules).</li>
        <li>Cliquez sur <b>Enregistrer</b>. Le panel crée tout seul la route du tunnel et l'enregistrement DNS : le site est en ligne en HTTPS en moins d'une minute, et apparaît dans « Domaines publiés » comme « En ligne ».</li>
      </ol>
      ${siteLinks()}`;

    // les volets ouverts restent ouverts quand la page se redessine
    const opened = new Set([...box.querySelectorAll('details[open][data-key]')].map((d) => d.dataset.key));
    const open = (key, byDefault = false) => (opened.has(key) || (byDefault && !box.childElementCount) ? 'open' : '');

    setHTML(
      box,
      a.tunnelId
        ? html`<div class="card inner tunnel-summary">
              <div class="card-header"><h3>${icon('check')} Tunnel prêt</h3><span class="spacer"></span>${connection()}</div>
              <table class="table kv-table">
                <tbody>
                  <tr><td class="muted">Compte Cloudflare</td><td>${a.accountName || a.accountId}</td></tr>
                  <tr><td class="muted">Tunnel</td><td><b>${a.tunnelName}</b> <code>${a.tunnelId.slice(0, 8)}…</code></td></tr>
                  <tr><td class="muted">Jeton d'API</td><td><code>${a.apiToken}</code></td></tr>
                </tbody>
              </table>
            </div>
            ${routesCard()}
            <details class="fold" data-key="publish" ${open('publish')}>
              <summary>${icon('globe')} Mettre un site en ligne</summary>
              <div class="fold-body">${publishGuide()}</div>
            </details>
            <details class="fold" data-key="token" ${open('token')}>
              <summary>${icon('key')} Remplacer le jeton d'API ${tip('Utile si le jeton a expiré ou a été supprimé sur Cloudflare. Le tunnel et les domaines restent en place.')}</summary>
              <div class="fold-body">
                ${apiForm()}
                <details class="sub-fold" data-key="token-guide" ${open('token-guide')}><summary>Comment créer un jeton</summary>${tokenGuide()}</details>
              </div>
            </details>
            <details class="fold" data-key="setup" ${open('setup')}>
              <summary>${icon('sliders')} Changer de compte ou recréer le tunnel ${tip('Recrée le tunnel (ou le retrouve s’il existe déjà sous ce nom) puis republie tous les domaines.')}</summary>
              <div class="fold-body">
                ${setupForm()}
              </div>
            </details>`
        : html`<ol class="stepper">
              <li class="${a.connected ? 'done' : ''}">
                <div class="stepper-title">Créer un jeton d'API Cloudflare ${tip('Ce jeton autorise le panel à créer le tunnel et les enregistrements DNS de vos sites, et rien d’autre. Les boutons du site de Cloudflare sont écrits ici comme à l’écran.')} ${a.connected ? html`<span class="badge st-running">Fait</span>` : ''}</div>
                <details class="sub-fold" data-key="token-guide" ${a.connected ? open('token-guide') : 'open'}>
                  <summary>${a.connected ? 'Revoir comment créer un jeton' : 'Comment créer le jeton (2 minutes)'}</summary>
                  ${tokenGuide()}
                </details>
                ${a.connected ? html`<p class="hint">Jeton enregistré : <code>${a.apiToken}</code> ${tip('Pour le remplacer, collez-en un autre ci-dessous.')}</p>` : ''}
                ${apiForm()}
              </li>
              <li class="${a.connected ? '' : 'disabled'}">
                <div class="stepper-title">Créer le tunnel ${tip(html`Choisissez votre compte Cloudflare, gardez le nom proposé (ou changez-le), puis cliquez sur <b>Créer le tunnel</b>.
                  Le panel installe cloudflared si besoin, crée le tunnel sur votre compte et le démarre : l'état en haut de la page passe à « Connecté ».`)}</div>
                ${setupForm()}
              </li>
              <li class="disabled">
                <div class="stepper-title">Mettre un site en ligne</div>
                ${publishGuide()}
              </li>
            </ol>`,
    );

    $('#api-form', box)?.addEventListener('submit', (e) => {
      e.preventDefault();
      const apiToken = e.target.apiToken.value;
      withBusy($('[type=submit]', e.target), async () => {
        ({ accounts } = await api.post('/tunnel/api/connect', { apiToken }));
        status = await api.get('/tunnel');
        toast('Jeton d’API vérifié');
        drawMode();
      });
    });
    if (a.connected && !accounts) {
      api.get('/tunnel/api/accounts').then(
        (r) => {
          accounts = r.accounts;
          if (page.active && mode === 'api' && !$('#setup-form [name=accountId]:focus', el)) drawMode();
        },
        (err) => toast(err.message, 'err'),
      );
    }
    $('#setup-form', box)?.addEventListener('submit', (e) => {
      e.preventDefault();
      const { accountId, name } = Object.fromEntries(new FormData(e.target));
      withBusy($('[type=submit]', e.target), async () => {
        if (!status.binary) await api.post('/tunnel/install');
        const result = await api.post('/tunnel/api/setup', { accountId, name });
        status = result.status;
        routingWarnings({ tunnel: result.sync });
        toast('Tunnel prêt');
        refresh(true);
      });
    });
    box.querySelector('[data-sync]')?.addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        const r = await api.post('/tunnel/sync');
        if (routingWarnings({ tunnel: r })) toast('Domaines synchronisés');
        refresh(true);
      }),
    );
    box.querySelectorAll('[data-replace]').forEach((b) =>
      b.addEventListener('click', async () => {
        const host = b.dataset.replace;
        if (!(await confirmDialog('Remplacer l’enregistrement DNS ?', `L'enregistrement DNS actuel de ${host} sera supprimé et remplacé par celui du tunnel.`, { danger: true, confirmLabel: 'Remplacer' }))) return;
        await withBusy(b, async () => {
          const r = await api.post('/tunnel/dns/replace', { hostname: host });
          routingWarnings({ tunnel: r });
          refresh(true);
        });
      }),
    );
  }

  function routesCard() {
    const synced = new Map((status.lastSync?.routes || []).map((r) => [r.hostname, r]));
    const STATUS = { ok: ['st-running', 'En ligne'], conflict: ['st-crashed', 'Conflit DNS'], 'no-zone': ['st-restarting', 'Domaine inconnu'], error: ['st-crashed', 'Erreur'] };
    return html`<div class="card inner">
      <div class="card-header">
        <h3>${icon('globe')} Domaines publiés</h3>
        <span class="spacer"></span>
        ${status.lastSync ? html`<span class="hint hide-sm">Synchronisé à ${formatTime(status.lastSync.at)}</span>` : ''}
        <button class="btn btn-sm" data-sync>${icon('refresh')} Synchroniser</button>
      </div>
      ${status.lastSync?.error && !synced.size ? html`<div class="alert err" style="margin:12px">${icon('alert')}<div>${status.lastSync.error}</div></div>` : ''}
      <div class="fm-scroll">
        <table class="table compact">
          <thead><tr><th>Domaine</th><th class="hide-sm">Vers</th><th>État</th></tr></thead>
          <tbody>
            ${status.routes.length
              ? status.routes.map((r) => {
                  const s = synced.get(r.hostname);
                  const [cls, label] = s ? STATUS[s.status] || ['', s.status] : ['', 'À synchroniser'];
                  return html`<tr>
                    <td><a href="https://${r.hostname}" target="_blank" rel="noopener">${r.hostname}</a><div class="hint">${r.label}</div></td>
                    <td class="hide-sm"><code>${r.service}</code></td>
                    <td>
                      <span class="badge ${cls}">${label}</span>${s && s.status !== 'ok' ? html`<div class="hint">${s.message}</div>` : ''}
                      ${s?.status === 'conflict' ? html`<button class="btn btn-sm replace-dns" data-replace="${r.hostname}" title="Remplacer l'enregistrement DNS existant par celui du tunnel">${icon('refresh')} Remplacer</button>` : ''}
                    </td>
                  </tr>`;
                })
              : html`<tr><td colspan="3" class="muted">Aucun domaine pour l'instant ${tip(html`Ajoutez-en un dans l'onglet <b>Paramètres</b> d'une application, ou le domaine du panel dans <b>Général</b>.`)}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  function openLog() {
    source?.close();
    const out = $('#tunnel-log', el);
    source = new EventSource('/api/tunnel/logs/stream');
    const add = (lines) => {
      for (const line of lines) {
        const row = document.createElement('div');
        row.className = `l ${line.s}`;
        const ts = document.createElement('span');
        ts.className = 'ts';
        ts.textContent = formatLogTime(line.t);
        const m = document.createElement('span');
        m.className = 'm';
        m.textContent = line.m;
        row.append(ts, m);
        out.appendChild(row);
      }
      while (out.childElementCount > 500) out.firstElementChild.remove();
      out.scrollTop = out.scrollHeight;
    };
    source.addEventListener('backlog', (e) => {
      out.textContent = '';
      const lines = JSON.parse(e.data);
      if (lines.length) add(lines);
      else out.innerHTML = String(html`<div class="console-empty">Le journal de cloudflared apparaîtra ici.</div>`);
    });
    source.onmessage = (e) => {
      out.querySelector('.console-empty')?.remove();
      add([JSON.parse(e.data)]);
    };
  }

  async function refresh(full = false) {
    clearTimeout(pollTimer);
    try {
      status = await api.get('/tunnel');
    } catch {
      // nouvel essai plus tard
    }
    if (!page.active) return;
    if (full) {
      mode = initialMode(status);
      rerender();
      return;
    }
    const badge = $('#conn-badge', el);
    if (badge) setHTML(badge, connection());
    pollTimer = setTimeout(() => refresh(), 5000);
  }

  el.addEventListener('click', async (e) => {
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn && modeBtn.dataset.mode !== mode) {
      mode = modeBtn.dataset.mode;
      el.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('selected', b.dataset.mode === mode));
      drawMode();
      return;
    }
    const install = e.target.closest('[data-install]');
    if (install) {
      await withBusy(install, async () => {
        const { version } = await api.post('/tunnel/install');
        toast(`cloudflared ${version} installé`);
        refresh(true);
      });
      return;
    }
    const check = e.target.closest('[data-check-update]');
    if (check) {
      await withBusy(check, async () => {
        status = await api.post('/tunnel/check-update');
        if (!page.active) return;
        setHTML($('#state-card', el), stateCard());
        if (status.latest?.error) toast(status.latest.error, 'err');
        else if (status.updateAvailable) toast(`La version ${status.latest.version} de cloudflared est disponible`, 'info');
        else toast(`cloudflared est à jour (version ${status.version})`);
      });
      return;
    }
    const restart = e.target.closest('[data-restart]');
    if (restart) {
      await withBusy(restart, async () => {
        status = await api.post('/tunnel/restart');
        toast('Tunnel redémarré');
      });
      return;
    }
    if (e.target.closest('[data-reset]')) {
      if (!(await confirmDialog('Supprimer la configuration ?', 'Le tunnel sera arrêté et ses jetons effacés du panel. Le tunnel et les enregistrements DNS restent sur votre compte Cloudflare (supprimez-les depuis Cloudflare si besoin).', { danger: true, confirmLabel: 'Supprimer' }))) return;
      await api.post('/tunnel/reset');
      toast('Configuration du tunnel supprimée');
      refresh(true);
    }
  });

  el.addEventListener('change', (e) => {
    if (e.target.id !== 'tunnel-enabled') return;
    const input = e.target;
    withBusy(input, async () => {
      try {
        status = await api.post('/tunnel/enabled', { enabled: input.checked });
        toast(input.checked ? 'Tunnel démarré' : 'Tunnel arrêté');
        refresh();
      } catch (err) {
        input.checked = !input.checked;
        throw err;
      }
    });
  });

  draw();
  refresh();
}

// ---- Général ---------------------------------------------------------------------------
async function generalTab(el, page) {
  const { settings, panel } = await api.get('/settings');
  if (!page.active) return;
  setHTML(
    el,
    html`<div class="grid grid-2">
      <form class="card" id="domain-form">
        <div class="card-header"><h2>${icon('globe')} Domaine du panel</h2></div>
        <div class="card-body">
          <div class="field">
            <label>Nom de domaine <span class="faint">(optionnel)</span> ${tip('Pour administrer le panel en HTTPS depuis Internet, via le tunnel Cloudflare (mode « géré depuis le panel »).')}</label>
            <input type="text" name="panelDomain" class="mono" value="${settings.panelDomain}" placeholder="panel.mondomaine.fr" spellcheck="false" />
          </div>
        </div>
        <div class="card-foot"><button class="btn btn-primary" type="submit">${icon('save')} Enregistrer</button></div>
      </form>

      <form class="card" id="ports-form">
        <div class="card-header"><h2>${icon('server')} Ports des sites ${tip('Plage dans laquelle le panel choisit automatiquement le port des nouveaux sites.')}</h2></div>
        <div class="card-body">
          <div class="form-grid">
            <div class="field"><label>Premier port</label><input type="number" name="start" value="${settings.portRange.start}" min="1024" max="65535" /></div>
            <div class="field"><label>Dernier port</label><input type="number" name="end" value="${settings.portRange.end}" min="1024" max="65535" /></div>
          </div>
        </div>
        <div class="card-foot"><button class="btn" type="submit">${icon('save')} Enregistrer</button></div>
      </form>

      <div class="card">
        <div class="card-header"><h2>${icon('info')} À propos</h2></div>
        <table class="table kv-table">
          <tbody>
            <tr><td class="muted">Version</td><td>AstraPanel ${panel.version}</td></tr>
            <tr><td class="muted">Node.js</td><td>${panel.node}</td></tr>
            <tr><td class="muted">Port du panel</td><td>${panel.port}</td></tr>
            <tr><td class="muted">Données</td><td><code>${panel.dataDir}</code> <button class="btn btn-ghost btn-sm btn-icon" data-copy="${panel.dataDir}" title="Copier">${icon('copy')}</button></td></tr>
          </tbody>
        </table>
      </div>
    </div>`,
  );
  $('#domain-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy($('[type=submit]', e.target), async () => {
      const result = await api.patch('/settings', { panelDomain: e.target.panelDomain.value });
      if (routingWarnings(result)) toast('Domaine du panel enregistré');
    });
  });
  $('#ports-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target));
    withBusy($('[type=submit]', e.target), async () => {
      await api.patch('/settings', { portRange: { start: Number(values.start), end: Number(values.end) } });
      toast('Plage de ports enregistrée');
    });
  });
  el.querySelector('[data-copy]')?.addEventListener('click', (e) => copyText(e.currentTarget.dataset.copy));
}

// ---- Hardware ---------------------------------------------------------------------------
async function hardwareTab(el, page) {
  let info = await api.get('/hardware');
  if (!page.active) return;
  let rebooting = false;
  const refresh = setInterval(async () => {
    if (rebooting) return;
    const next = await api.get('/hardware').catch(() => null);
    if (next && page.active && !rebooting) {
      info = next;
      draw();
    }
  }, 15_000);
  page.onCleanup(() => clearInterval(refresh));

  const power = () => {
    const t = info.throttling;
    if (t.underVoltage) return html`<span class="badge st-crashed">Sous-tension en ce moment</span>`;
    if (t.throttled) return html`<span class="badge st-restarting">Processeur ralenti</span>`;
    if (t.underVoltageOccurred) return html`<span class="badge st-restarting">Sous-tension depuis le démarrage</span>`;
    return html`<span class="badge st-running">Correcte</span>`;
  };

  function draw() {
    const r = info.reboot;
    setHTML(
      el,
      html`<div class="stack">
        <div class="card">
          <div class="card-header"><h2>${icon('cpu')} Machine</h2><span class="spacer"></span><span class="badge plain">${info.hostname}</span></div>
          <table class="table kv-table">
            <tbody>
              <tr><td class="muted">Modèle</td><td><b>${info.model}</b></td></tr>
              <tr><td class="muted">Processeur</td><td>${[info.cpuModel, `${info.cpus} cœurs`, info.cpuMaxMHz ? `${(info.cpuMaxMHz / 1000).toLocaleString('fr-FR')} GHz max.` : ''].filter(Boolean).join(' · ')}</td></tr>
              <tr><td class="muted">Mémoire vive</td><td>${formatBytes(info.memory?.total)} <span class="muted">· ${formatBytes(info.memory?.available)} disponibles</span></td></tr>
              <tr><td class="muted">Stockage du panel</td><td>${info.disk ? html`${formatBytes(info.disk.total)} <span class="muted">· ${formatBytes(info.disk.free)} libres</span>` : '—'}</td></tr>
              <tr><td class="muted">Température</td><td>${info.temperature != null ? `${info.temperature.toFixed(1).replace('.', ',')} °C` : html`<span class="muted">Capteur indisponible</span>`}${info.fan != null ? html` <span class="muted">· ventilateur ${info.fan.toLocaleString('fr-FR')} tr/min</span>` : ''}</td></tr>
              ${info.throttling ? html`<tr><td class="muted">Alimentation</td><td>${power()}</td></tr>` : ''}
              <tr><td class="muted">Système</td><td>${info.os} <span class="muted">· noyau ${info.kernel} · ${info.arch}</span></td></tr>
              <tr><td class="muted">Adresse IP</td><td>${info.addresses?.length ? info.addresses.map((a) => a.address).join(', ') : '—'}</td></tr>
              <tr><td class="muted">Allumée depuis</td><td>${formatDuration(info.uptime * 1000)} <span class="muted">· démarrée le ${formatDate(info.bootedAt)}</span></td></tr>
            </tbody>
          </table>
        </div>

        <div class="card danger-card" id="reboot-card">
          <div class="card-header danger-head">
            <h2>${icon('restart')} Redémarrer la machine ${tip(html`Redémarre la machine. Le panel et le tunnel Cloudflare repartent tout seuls, ainsi que les applications dont l'option
              <b>Démarrer avec la machine</b> est activée. Comptez une à deux minutes pendant lesquelles vos sites et bots sont hors ligne.`)}</h2>
          </div>
          ${r.available
            ? ''
            : html`<div class="card-body"><div class="alert warn">${icon('alert')}<div>Le service de redémarrage n'est pas encore installé sur la machine : il le sera à la prochaine mise à jour du panel (ou en relançant <code>sudo ./install.sh</code>).</div></div></div>`}
          <div class="card-foot">
            <button class="btn btn-danger" data-reboot ${r.available && !r.pending ? '' : 'disabled'}>${icon('restart')} Redémarrer la machine…</button>
          </div>
        </div>
      </div>`,
    );
    $('[data-reboot]', el)?.addEventListener('click', confirmReboot);
  }

  async function confirmReboot(e) {
    const ok = await confirmDialog(
      'Redémarrer la machine ?',
      `${info.model} (${info.hostname}) va redémarrer maintenant. Le panel, vos sites et vos bots seront indisponibles pendant une à deux minutes.`,
      { danger: true, confirmLabel: 'Valider le redémarrage' },
    );
    if (!ok) return;
    await withBusy(e.target.closest('button'), async () => {
      const { bootId } = await api.post('/hardware/reboot', { confirm: true });
      rebooting = true;
      // même écran flouté que pour une mise à jour ; il se ferme et recharge la page au retour du panel
      openRebootOverlay({ bootId: bootId || info.bootId, host: `${info.model} (${info.hostname})` });
    });
  }

  draw();
}

// ---- Journal d'activité ---------------------------------------------------------------
const CATEGORIES = { application: 'Applications', fichiers: 'Fichiers', compte: 'Comptes et connexions', tunnel: 'Tunnel Cloudflare', panel: 'Panel', machine: 'Machine' };
const CATEGORY_ICONS = { application: 'box', fichiers: 'folder', compte: 'user', tunnel: 'cloud', panel: 'sliders', machine: 'cpu' };

async function journalTab(el, page, userFilter = '') {
  const filters = { user: userFilter, app: '', category: '', q: '' };
  let data = null;
  let entries = [];
  let searchTimer = null;
  page.onCleanup(() => clearTimeout(searchTimer));

  async function load({ append = false } = {}) {
    const params = { ...filters, limit: 100 };
    if (append && entries.length) params.before = entries[entries.length - 1].at;
    const next = await api.get(`/audit?${qs(params)}`);
    if (!page.active) return;
    data = next;
    entries = append ? [...entries, ...next.entries] : next.entries;
    drawList();
  }

  const who = (e) =>
    e.user
      ? html`<div class="user-cell">${avatar({ ...e.user, avatar: data.users.find((u) => u.id === e.user.id)?.avatar }, 'sm')}<span class="truncate">${e.user.username}</span></div>`
      : html`<span class="muted">Anonyme</span>`;

  function drawList() {
    const box = $('#journal-list', el);
    const userOptions = data.users.map((u) => html`<option value="${u.id}" ${u.id === filters.user ? 'selected' : ''}>${u.username}</option>`);
    const appOptions = data.apps.map((a) => html`<option value="${a.id}" ${a.id === filters.app ? 'selected' : ''}>${a.name}</option>`);
    setHTML($('#f-user', el), html`<option value="">Tous les comptes</option><option value="-" ${filters.user === '-' ? 'selected' : ''}>Anonyme (échecs de connexion)</option>${userOptions}`);
    setHTML($('#f-app', el), html`<option value="">Toutes les applications</option>${appOptions}`);
    setHTML(
      box,
      entries.length
        ? html`<table class="table journal-table">
            <thead><tr><th>Date</th><th>Compte</th><th>Action</th><th class="hide-sm">Adresse IP</th></tr></thead>
            <tbody>
              ${entries.map(
                (e) => html`<tr>
                  <td class="nowrap muted">${formatDate(e.at)}</td>
                  <td>${who(e)}</td>
                  <td>
                    <div class="journal-action">${icon(CATEGORY_ICONS[e.category] || 'info')}<b>${e.label}</b>${e.app ? html`<a class="journal-app" href="#/apps/${e.app.id}">${e.app.name}</a>` : ''}</div>
                    ${e.detail ? html`<div class="hint journal-detail">${e.detail}</div>` : ''}
                  </td>
                  <td class="hide-sm mono muted">${e.ip || '—'}</td>
                </tr>`,
              )}
            </tbody>
          </table>
          ${data.more ? html`<div class="card-foot"><button class="btn btn-sm" data-more>${icon('chevronDown')} Afficher plus</button></div>` : ''}`
        : html`<div class="empty-small muted">${filters.user || filters.app || filters.category || filters.q ? 'Aucune action ne correspond à ces filtres.' : 'Aucune action enregistrée pour l’instant.'}</div>`,
    );
    $('[data-more]', box)?.addEventListener('click', (e) => withBusy(e.target.closest('button'), () => load({ append: true })));
  }

  setHTML(
    el,
    html`<div class="card">
      <div class="card-header">
        <h2>${icon('clock')} Journal d'activité ${tip('Chaque action faite dans le panel est enregistrée : connexions, applications, fichiers, comptes, tunnel, mises à jour, redémarrages. Les mots de passe, jetons et valeurs des variables ne sont jamais enregistrés. Les 10 000 dernières actions sont conservées.')}</h2>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-ghost" data-reload>${icon('refresh')} Actualiser</button>
      </div>
      <div class="card-body journal-filters">
        <select id="f-user" aria-label="Compte"></select>
        <select id="f-app" aria-label="Application"></select>
        <select id="f-category" aria-label="Type d'action">
          <option value="">Toutes les actions</option>
          ${Object.entries(CATEGORIES).map(([id, label]) => html`<option value="${id}">${label}</option>`)}
        </select>
        <input type="search" id="f-q" placeholder="Rechercher (fichier, domaine, IP…)" aria-label="Rechercher" />
      </div>
      <div id="journal-list"><div class="empty-small muted">Chargement…</div></div>
    </div>`,
  );
  const onFilter = (key) => (e) => {
    filters[key] = e.target.value;
    if (key === 'user') history.replaceState(null, '', `#/settings/journal${filters.user ? `/${filters.user}` : ''}`);
    load();
  };
  $('#f-user', el).addEventListener('change', onFilter('user'));
  $('#f-app', el).addEventListener('change', onFilter('app'));
  $('#f-category', el).addEventListener('change', onFilter('category'));
  $('#f-q', el).addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => onFilter('q')(e), 300);
  });
  $('[data-reload]', el).addEventListener('click', (e) => withBusy(e.target.closest('button'), () => load()));
  await load();
}
