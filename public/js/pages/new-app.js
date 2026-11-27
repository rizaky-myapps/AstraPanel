import { api } from '../api.js';
import { refreshApps } from '../state.js';
import { openOverlay, stepsAt } from '../overlay.js';
import { $, html, icon, pageHero, routingWarnings, setHTML, tip, toast, toggle } from '../ui.js';

const TYPES = [
  { id: 'bot', title: 'Bot Discord', desc: 'Un bot discord.js, ou tout programme Node.js sans site web.', icon: 'bot', placeholder: 'Mon super bot' },
  { id: 'node', title: 'Site Node.js', desc: 'Express, Fastify, Next.js… Le port est fourni via la variable PORT.', icon: 'globe', placeholder: 'Mon site' },
  { id: 'static', title: 'Site statique', desc: 'HTML / CSS / JS, ou le résultat d’un build (Vite, React…).', icon: 'layers', placeholder: 'Mon site' },
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
  };

  function render() {
    const type = TYPES.find((t) => t.id === f.type);
    const isStatic = f.type === 'static';
    const hasPort = f.type !== 'bot';
    setHTML(
      root,
      html`<a class="back" href="#/">${icon('back')} Tableau de bord</a>
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
                <label for="na-type">Type d'application ${tip(type.desc)}</label>
                <div class="type-select">
                  <span class="app-icon ${f.type}">${icon(type.icon)}</span>
                  <select id="na-type" name="type">
                    ${TYPES.map((t) => html`<option value="${t.id}" ${t.id === f.type ? 'selected' : ''}>${t.title}</option>`)}
                  </select>
                  <span class="type-select-caret">${icon('chevronDown')}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header"><h2><span class="step-num">2</span> Configuration</h2></div>
            <div class="card-body form-grid">
              ${isStatic
                ? ''
                : html`<div class="field full">
                    <label>Commande de démarrage ${tip(html`Par exemple <code>node index.js</code>, plus léger que <code>npm start</code> (un seul processus au lieu de deux).`)}</label>
                    <input type="text" name="startCommand" class="mono" value="${f.startCommand}" spellcheck="false" />
                  </div>`}
              <div class="field">
                <label>Installation des dépendances ${tip('Lancée s’il y a un package.json. Laissez vide pour la désactiver.')}</label>
                <input type="text" name="installCommand" class="mono" value="${f.installCommand}" spellcheck="false" />
              </div>
              <div class="field">
                <label>Commande de build <span class="faint">(optionnel)</span></label>
                <input type="text" name="buildCommand" class="mono" value="${f.buildCommand}" placeholder="npm run build" spellcheck="false" />
              </div>
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
              <div class="full new-app-toggles">
                <label class="check">${toggle('autoRestart', f.autoRestart)}<span>Redémarrage automatique ${tip('Relance l’application si elle plante.')}</span></label>
                <label class="check">${toggle('startOnBoot', f.startOnBoot)}<span>Démarrer avec la machine ${tip('Lance l’application à chaque démarrage de la machine.')}</span></label>
              </div>
              <div class="full error-text"></div>
            </div>
            <div class="card-foot">
              <a class="btn btn-ghost" href="#/">Annuler</a>
              <button class="btn btn-primary" type="submit">${icon('check')} Créer l'application</button>
            </div>
          </div>
        </form>`,
    );
  }

  render();
  // le nom se tape tout de suite (pas sur téléphone : le clavier masquerait la page)
  if (matchMedia('(pointer: fine)').matches) $('#na-name', root)?.focus();

  root.addEventListener('change', (e) => {
    if (e.target.name !== 'type') return;
    f.type = e.target.value;
    if (!f.startTouched) f.startCommand = defaultStart(f.type);
    render();
    $('#na-type', root).focus();
  });

  root.addEventListener('input', (e) => {
    const { name } = e.target;
    if (!name || name === 'type' || !(name in f)) return;
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

    const body = {
      name: f.name,
      type: f.type,
      source: 'empty',
      installCommand: f.installCommand,
      buildCommand: f.buildCommand,
      autoRestart: f.autoRestart,
      startOnBoot: f.startOnBoot,
    };
    if (f.type !== 'static') body.startCommand = f.startCommand;
    if (f.type === 'static') Object.assign(body, { staticDir: f.staticDir, spa: f.spa });
    if (f.type !== 'bot') Object.assign(body, { port: f.port || null, domains: f.domains });

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
      location.hash = `#/apps/${app.id}/files`; // dossier vide : on y dépose le code
      toast(`« ${app.name} » a été créée`);
      setTimeout(() => screen.close(), 250);
    } catch (err) {
      screen.close();
      error.textContent = err.message;
      button.disabled = false;
    }
  });
}
