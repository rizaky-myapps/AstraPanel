import { api } from '../api.js';
import { refreshApps } from '../state.js';
import { openOverlay, stepsAt } from '../overlay.js';
import { $, html, icon, pageHero, routingWarnings, setHTML, tip, toast, toggle } from '../ui.js';
import { fillVersions, limitPortField, mcFieldsHTML, readMcFields } from '../minecraft-ui.js';
import { navigate } from '../router.js';

const TYPES = [
  { id: 'bot', title: 'Bot Discord', desc: 'Un bot discord.js, ou tout programme Node.js sans site web.', icon: 'bot', placeholder: 'Mon super bot' },
  { id: 'node', title: 'Site Node.js', desc: 'Express, Fastify, Next.js… Le port est fourni via la variable PORT.', icon: 'globe', placeholder: 'Mon site' },
  { id: 'static', title: 'Site statique', desc: 'HTML / CSS / JS, ou le résultat d’un build (Vite, React…).', icon: 'layers', placeholder: 'Mon site' },
  { id: 'minecraft', title: 'Serveur Minecraft', desc: 'Serveur Java Edition (Paper ou Vanilla) : le panel télécharge Java et le serveur, puis le démarre.', icon: 'cube', placeholder: 'Mon serveur' },
];

const defaultStart = (type) => (type === 'static' ? '' : 'npm start');

// L'application est créée avec un dossier vide : le code s'ajoute ensuite depuis ses onglets « Fichiers » ou
// « Déploiement » (dépôt Git, archive), et ses variables (.env) depuis l'onglet « Variables ».
export function renderNewApp(view) {
  // Les écouteurs sont posés sur `root`, qui disparaît quand on change de page.
  const root = document.createElement('div');
  view.replaceChildren(root);
  const f = {
    name: '',
    type: 'bot',
    startCommand: defaultStart('bot'),
    startTouched: false,
    installCommand: 'npm install',
    buildCommand: '',
    staticDir: '.',
    spa: false,
    port: '',
    domains: '',
    autoRestart: true,
    startOnBoot: true,
    // serveur Minecraft (mémoire en Mo)
    mc: { flavor: 'paper', version: 'latest', ramMin: 1024, ramMax: 2048, cores: 0 },
    eula: false,
  };
  let machine = null; // mémoire et cœurs de la machine, connus après le premier chargement des versions

  function render() {
    const type = TYPES.find((t) => t.id === f.type);
    const isStatic = f.type === 'static';
    const isMc = f.type === 'minecraft';
    const hasPort = f.type !== 'bot' && !isMc;
    setHTML(
      root,
      html`<a class="back" href="/home">${icon('back')} Tableau de bord</a>
        ${pageHero({
          icon: 'plus',
          tone: 'green',
          title: 'Nouvelle application',
          info: 'Le dossier de l’application est créé vide : ajoutez ensuite votre code dans son onglet « Fichiers », ou depuis un dépôt Git ou une archive dans l’onglet « Déploiement ». Les variables d’environnement (.env) se gèrent dans l’onglet « Variables ».',
        })}
        <form id="new-app" class="stack new-app" novalidate>
          <div class="card">
            <div class="card-header"><h2><span class="step-num">1</span> Application</h2></div>
            <div class="card-body new-app-id">
              <div class="field">
                <label for="na-name">Nom</label>
                <input id="na-name" type="text" name="name" class="new-app-name" value="${f.name}" placeholder="${type.placeholder}" maxlength="60" autocomplete="off" />
              </div>
              <div class="field">
                <label for="na-type" id="na-type-label">Type d'application ${tip(type.desc)}</label>
                <div class="type-picker">
                  <button type="button" class="type-picker-btn" id="na-type" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="na-type-label na-type">
                    <span class="app-icon ${f.type}">${icon(type.icon)}</span>
                    <span class="type-picker-value">${type.title}</span>
                    <span class="type-select-caret">${icon('chevronDown')}</span>
                  </button>
                  <ul class="type-picker-list" role="listbox" aria-labelledby="na-type-label" hidden>
                    ${TYPES.map(
                      (t) => html`<li role="option" data-type="${t.id}" aria-selected="${t.id === f.type}" tabindex="-1">
                        <span class="app-icon ${t.id}">${icon(t.icon)}</span>
                        <span class="type-picker-name">${t.title}</span>
                        <span class="type-picker-check">${icon('check')}</span>
                      </li>`,
                    )}
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header"><h2><span class="step-num">2</span> Configuration</h2></div>
            <div class="card-body form-grid">
              ${isMc
                ? html`${mcFieldsHTML(f.mc, machine)}
                    <div class="field">
                      <label for="mc-port">Port ${tip('Les joueurs se connectent avec l’adresse de la machine et ce port (25565 : port habituel de Minecraft, qu’on n’a pas besoin de taper). Pour jouer depuis Internet, ce port doit être ouvert dans votre box : Paramètres → Gestion de PORT peut s’en charger.')}</label>
                      <input id="mc-port" type="number" name="port" value="${f.port}" placeholder="Automatique (25565)" min="1024" max="65535" />
                    </div>
                    <div class="field full">
                      <label for="mc-domain">Nom de domaine <span class="faint">(optionnel)</span> ${tip('Adresse que les joueurs tapent dans Minecraft, par exemple mc.mondomaine.fr. Le panel crée chez Cloudflare un enregistrement « DNS uniquement » vers l’adresse IP publique de votre box, tenu à jour si elle change (Paramètres → Tunnel Cloudflare, mode « Géré depuis le panel »). Il faut aussi rediriger le port du serveur vers la machine dans votre box.')}</label>
                      <input id="mc-domain" type="text" name="domains" class="mono" value="${f.domains}" placeholder="mc.mondomaine.fr" spellcheck="false" />
                    </div>
                    <div class="full new-app-toggles">
                      <label class="check">${toggle('autoRestart', f.autoRestart)}<span>Redémarrage automatique ${tip('Relance le serveur s’il plante.')}</span></label>
                      <label class="check">${toggle('startOnBoot', f.startOnBoot)}<span>Démarrer avec la machine ${tip('Lance le serveur à chaque démarrage de la machine.')}</span></label>
                      <label class="check mc-eula">${toggle('eula', f.eula)}<span>J'accepte le <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">CLUF de Minecraft</a> ${tip('Le contrat de licence de Mojang : obligatoire pour faire tourner un serveur Minecraft.')}</span></label>
                    </div>
                    <div class="full error-text"></div>`
                : ''}
              ${isStatic || isMc
                ? ''
                : html`<div class="field full">
                    <label>Commande de démarrage ${tip(html`Par exemple <code>node index.js</code>, plus léger que <code>npm start</code> (un seul processus au lieu de deux).`)}</label>
                    <input type="text" name="startCommand" class="mono" value="${f.startCommand}" spellcheck="false" />
                  </div>`}
              ${isMc
                ? ''
                : html`<div class="field">
                      <label>Installation des dépendances ${tip('Lancée s’il y a un package.json. Laissez vide pour la désactiver.')}</label>
                      <input type="text" name="installCommand" class="mono" value="${f.installCommand}" spellcheck="false" />
                    </div>
                    <div class="field">
                      <label>Commande de build <span class="faint">(optionnel)</span></label>
                      <input type="text" name="buildCommand" class="mono" value="${f.buildCommand}" placeholder="npm run build" spellcheck="false" />
                    </div>`}
              ${isStatic
                ? html`<div class="field">
                      <label>Dossier à servir ${tip(html`<code>.</code> pour la racine, <code>dist</code> ou <code>build</code> après un build.`)}</label>
                      <input type="text" name="staticDir" class="mono" value="${f.staticDir}" placeholder="." spellcheck="false" />
                    </div>
                    <div class="field">
                      <label>&nbsp;</label>
                      <label class="check">${toggle('spa', f.spa)}<span>Application monopage (SPA) ${tip('Renvoie index.html pour les adresses inconnues (React Router, Vue Router…).')}</span></label>
                    </div>`
                : ''}
              ${hasPort
                ? html`<div class="field">
                      <label>Port ${tip(html`Votre code doit écouter sur <code>process.env.PORT</code>. Laissez vide : le panel en choisit un libre.`)}</label>
                      <input type="number" name="port" value="${f.port}" placeholder="Automatique" min="1024" max="65535" />
                    </div>
                    <div class="field">
                      <label>Nom(s) de domaine <span class="faint">(optionnel)</span> ${tip('Publié en HTTPS par le tunnel Cloudflare (Paramètres → Tunnel Cloudflare). Plusieurs domaines : séparez-les par des virgules.')}</label>
                      <input type="text" name="domains" class="mono" value="${f.domains}" placeholder="monsite.fr, www.monsite.fr" spellcheck="false" />
                    </div>`
                : ''}
              ${isMc
                ? ''
                : html`<div class="full new-app-toggles">
                      <label class="check">${toggle('autoRestart', f.autoRestart)}<span>Redémarrage automatique ${tip('Relance l’application si elle plante.')}</span></label>
                      <label class="check">${toggle('startOnBoot', f.startOnBoot)}<span>Démarrer avec la machine ${tip('Lance l’application à chaque démarrage de la machine.')}</span></label>
                    </div>
                    <div class="full error-text"></div>`}
            </div>
            <div class="card-foot">
              <a class="btn btn-ghost" href="/home">Annuler</a>
              <button class="btn btn-primary" type="submit">${icon('check')} ${isMc ? 'Créer le serveur' : 'Créer l’application'}</button>
            </div>
          </div>
        </form>`,
    );
    // serveur de jeux : seulement les ports joignables depuis Internet (IPv4 partagée)
    if (isMc) limitPortField(root);
  }

  // serveur Minecraft : versions disponibles (et mémoire / cœurs de la machine pour les limites)
  const loadVersions = async () => {
    if (f.type !== 'minecraft') return;
    const info = await fillVersions(root, f.mc.flavor);
    if (info && !machine) {
      machine = { memory: info.memory, cores: info.cores };
      keepMc();
      render();
      loadVersions();
    }
  };
  // garde les valeurs des champs Minecraft avant de redessiner la page
  const keepMc = () => {
    const form = $('#new-app', root);
    if (form?.querySelector('[name=mcFlavor]')) f.mc = readMcFields(form);
  };

  render();
  loadVersions();
  // le nom se tape tout de suite (pas sur téléphone : le clavier masquerait la page)
  if (matchMedia('(pointer: fine)').matches) $('#na-name', root)?.focus();

  root.addEventListener('change', (e) => {
    if (e.target.name === 'mcFlavor') {
      keepMc();
      fillVersions(root, e.target.value);
    }
  });

  // ---- Menu « Type d'application » : liste sur mesure (icônes, coche, clavier) ----
  const setType = (id) => {
    if (id !== f.type) {
      keepMc();
      f.type = id;
      if (!f.startTouched) f.startCommand = defaultStart(f.type);
      render();
      loadVersions();
    } else closeTypes();
    $('#na-type', root).focus();
  };
  const typeList = () => $('.type-picker-list', root);
  const options = () => [...typeList().querySelectorAll('[role=option]')];
  const openTypes = () => {
    const list = typeList();
    list.hidden = false;
    $('#na-type', root).setAttribute('aria-expanded', 'true');
    (list.querySelector('[aria-selected=true]') || options()[0]).focus();
  };
  function closeTypes() {
    const list = typeList();
    if (!list || list.hidden) return;
    list.hidden = true;
    $('#na-type', root).setAttribute('aria-expanded', 'false');
  }
  root.addEventListener('click', (e) => {
    if (e.target.closest('#na-type')) {
      if (typeList().hidden) openTypes();
      else closeTypes();
      return;
    }
    const option = e.target.closest('.type-picker-list [role=option]');
    if (option) setType(option.dataset.type);
  });
  root.addEventListener('keydown', (e) => {
    if (e.target.closest('#na-type') && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openTypes();
      return;
    }
    const option = e.target.closest('.type-picker-list [role=option]');
    if (!option) return;
    const all = options();
    const i = all.indexOf(option);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      all[e.key === 'Home' ? 0 : all.length - 1].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setType(option.dataset.type);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeTypes();
      $('#na-type', root).focus();
    } else if (e.key === 'Tab') closeTypes();
  });
  // clic ailleurs : la liste se ferme (écouteur retiré quand on quitte la page)
  const outside = (e) => {
    if (!root.isConnected) return document.removeEventListener('mousedown', outside);
    if (!e.target.closest('.type-picker')) closeTypes();
    return undefined;
  };
  document.addEventListener('mousedown', outside);

  root.addEventListener('input', (e) => {
    const { name } = e.target;
    if (!name || name === 'type' || !(name in f) || name === 'mc') return;
    f[name] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (name === 'startCommand') f.startTouched = true;
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const error = $('.error-text', form);
    const button = $('[type=submit]', form);
    error.textContent = '';
    if (!f.name.trim()) {
      error.textContent = 'Donnez un nom à votre application';
      $('#na-name', form).focus();
      return;
    }

    const isMc = f.type === 'minecraft';
    if (isMc) {
      f.mc = readMcFields(form);
      if (!f.eula) {
        error.textContent = 'Acceptez le CLUF de Minecraft pour créer le serveur';
        return;
      }
      if (!(f.mc.ramMax >= f.mc.ramMin && f.mc.ramMin >= 256)) {
        error.textContent = 'Mémoire : le minimum doit être inférieur ou égal au maximum';
        return;
      }
    }
    const body = {
      name: f.name,
      type: f.type,
      source: 'empty',
      installCommand: f.installCommand,
      buildCommand: f.buildCommand,
      autoRestart: f.autoRestart,
      startOnBoot: f.startOnBoot,
    };
    if (isMc) {
      delete body.installCommand;
      delete body.buildCommand;
      Object.assign(body, { mc: { ...f.mc, eula: true }, port: f.port || null, domains: f.domains, start: true });
    } else {
      if (f.type !== 'static') body.startCommand = f.startCommand;
      if (f.type === 'static') Object.assign(body, { staticDir: f.staticDir, spa: f.spa });
      if (f.type !== 'bot') Object.assign(body, { port: f.port || null, domains: f.domains });
    }

    button.disabled = true;
    // écran flouté pendant la création ; il disparaît une fois l'application ouverte
    const labels = ['Création de l’application', 'Ouverture de l’application'];
    const screen = openOverlay('Création de l’application');
    const typeLabel = TYPES.find((t) => t.id === f.type)?.title || '';
    const show = (index, percent, detail) =>
      screen.render({ title: 'Création de l’application', subtitle: html`<b>${f.name.trim()}</b> · ${typeLabel}`, percent, detail, steps: stepsAt(labels, index) });
    show(0, 25, 'Création du dossier et de la configuration…');
    try {
      const { app, ...routing } = await api.post('/apps', body);
      routingWarnings(routing);
      show(1, 100, 'Ouverture de l’application…');
      await refreshApps();
      // l'écran reste visible un court instant (pas de clignotement), puis l'application s'ouvre et l'écran disparaît
      await new Promise((r) => setTimeout(r, Math.max(0, 700 - (Date.now() - screen.startedAt))));
      // dossier vide : on y dépose le code ; serveur Minecraft : son installation se suit dans la console
      navigate(`/apps/${app.id}/${isMc ? 'console' : 'files'}`);
      toast(`« ${app.name} » a été créée`);
      setTimeout(() => screen.close(), 250);
    } catch (err) {
      screen.close();
      error.textContent = err.message;
      button.disabled = false;
    }
  });
}
