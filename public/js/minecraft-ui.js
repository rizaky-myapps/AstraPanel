// Champs d'un serveur Minecraft (création et onglet Paramètres) : type de serveur, version, mémoire, cœurs.
import { api } from './api.js';
import { html, setHTML, tip } from './ui.js';

export const FLAVOR_LABELS = { paper: 'Paper', vanilla: 'Vanilla' };
const cache = new Map();

// Versions disponibles et ressources de la machine (gardées le temps de la session)
export function mcInfo(flavor) {
  if (!cache.has(flavor)) {
    cache.set(
      flavor,
      api.get(`/minecraft/versions?flavor=${flavor}`).catch((err) => {
        cache.delete(flavor);
        throw err;
      }),
    );
  }
  return cache.get(flavor);
}

const go = (mo) => Math.round((mo / 1024) * 4) / 4; // Mo → Go, au quart près
const coresLabel = (n) => `${n} cœur${n > 1 ? 's' : ''}`;

// mc : { flavor, version, ramMin, ramMax, cores } (mémoire en Mo) ; machine : { memory (Mo), cores } si connue
export function mcFieldsHTML(mc, machine = null) {
  const cores = machine?.cores || Math.max(mc.cores || 0, 1);
  return html`<div class="field">
      <label for="mc-flavor">Serveur ${tip(html`<b>Paper</b> (recommandé) : plus rapide et compatible avec les plugins Bukkit / Spigot.<br /><b>Vanilla</b> : le serveur officiel de Mojang, sans modification.`)}</label>
      <select id="mc-flavor" name="mcFlavor">
        ${Object.entries(FLAVOR_LABELS).map(([id, label]) => html`<option value="${id}" ${id === mc.flavor ? 'selected' : ''}>${label}</option>`)}
      </select>
    </div>
    <div class="field">
      <label for="mc-version">Version ${tip('« Dernière version » suit toujours la plus récente (à chaque « Déployer maintenant »). Une version précise reste fixe.')}</label>
      <select id="mc-version" name="mcVersion" data-current="${mc.version}">
        <option value="latest" ${mc.version === 'latest' ? 'selected' : ''}>Dernière version</option>
        ${mc.version !== 'latest' ? html`<option value="${mc.version}" selected>${mc.version}</option>` : ''}
      </select>
    </div>
    <div class="field">
      <label for="mc-ram-min">Mémoire minimale ${tip('Mémoire réservée dès le démarrage du serveur (option -Xms de Java).')}</label>
      <div class="input-unit"><input id="mc-ram-min" type="number" name="ramMin" value="${go(mc.ramMin)}" min="0.25" step="0.25" ${machine ? html`max="${go(machine.memory)}"` : ''} required /><span>Go</span></div>
    </div>
    <div class="field">
      <label for="mc-ram-max">Mémoire maximale ${tip(html`Le serveur n'utilisera jamais plus (option -Xmx de Java).${machine ? html` La machine a ${go(machine.memory)} Go : gardez-en pour le système et vos autres applications.` : ''} Comptez 2 à 4 Go pour quelques joueurs, davantage avec beaucoup de joueurs ou de plugins.`)}</label>
      <div class="input-unit"><input id="mc-ram-max" type="number" name="ramMax" value="${go(mc.ramMax)}" min="0.5" step="0.25" ${machine ? html`max="${go(machine.memory)}"` : ''} required /><span>Go</span></div>
    </div>
    <div class="field">
      <label for="mc-cores">Cœurs alloués ${tip('Cœurs du processeur que le serveur peut utiliser. « Tous » : aucune limite.')}</label>
      <select id="mc-cores" name="cores">
        <option value="0" ${!mc.cores ? 'selected' : ''}>Tous${machine ? ` (${coresLabel(machine.cores)})` : ''}</option>
        ${Array.from({ length: cores }, (_, i) => i + 1).map((n) => html`<option value="${n}" ${n === mc.cores ? 'selected' : ''}>${coresLabel(n)}</option>`)}
      </select>
    </div>`;
}

// Remplit la liste des versions (et la limite des cœurs) une fois les informations reçues
export async function fillVersions(root, flavor) {
  const select = root.querySelector('#mc-version');
  if (!select) return null;
  const current = select.value || select.dataset.current || 'latest';
  select.disabled = true;
  try {
    const info = await mcInfo(flavor);
    if (!select.isConnected) return info;
    setHTML(
      select,
      html`<option value="latest">Dernière version (${info.versions[0] || '?'})</option>${info.versions.map((v) => html`<option value="${v}">${v}</option>`)}`,
    );
    select.value = info.versions.includes(current) || current === 'latest' ? current : 'latest';
    return info;
  } catch (err) {
    select.title = err.message;
    return null;
  } finally {
    select.disabled = false;
  }
}

export function readMcFields(form) {
  const num = (name) => Number(String(form.querySelector(`[name=${name}]`).value).replace(',', '.'));
  return {
    flavor: form.querySelector('[name=mcFlavor]').value,
    version: form.querySelector('[name=mcVersion]').value || 'latest',
    ramMin: Math.round(num('ramMin') * 1024),
    ramMax: Math.round(num('ramMax') * 1024),
    cores: Number(form.querySelector('[name=cores]').value) || 0,
  };
}
