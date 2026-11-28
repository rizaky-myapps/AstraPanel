import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lanRequest } from './lan.js';

// Client de l'API Freebox OS (Freebox Ultra, Pop, Delta, Revolution…), joint sur le réseau local.
//
// - découverte : GET /api_version (sans authentification) donne la version de l'API ;
// - autorisation, une seule fois : POST login/authorize/ → l'utilisateur valide sur l'écran de la Freebox,
//   le panel reçoit un jeton d'application (app_token) ;
// - session : GET login/ donne un défi, mot de passe = HMAC-SHA1(défi, clé = app_token), POST login/session/
//   → jeton de session, envoyé dans l'en-tête X-Fbx-App-Auth ;
// - redirections de ports : fw/redir/ (le droit « Modification des réglages de la Freebox » est nécessaire).
//
// HTTPS avec les certificats racine de Free (freebox-ca.pem) ; HTTP seulement si HTTPS n'a jamais fonctionné
// avec cette box (anciens modèles). ASTRA_FREEBOX_URL remplace l'adresse (tests).
export const FREEBOX_HOST = 'mafreebox.freebox.fr';
export const FREEBOX_APP_ID = 'fr.astrapanel';
const CA = readFileSync(new URL('./freebox-ca.pem', import.meta.url));

export const RIGHTS_HELP =
  'Dans Freebox OS (mafreebox.freebox.fr) : Paramètres de la Freebox → Gestion des accès → Applications → AstraPanel → cochez « Modification des réglages de la Freebox ».';

const MESSAGES = {
  insufficient_rights: `Le panel n’a pas le droit de modifier les réglages de la Freebox. ${RIGHTS_HELP}`,
  invalid_token: 'L’autorisation du panel a été retirée sur la Freebox : reconnectez-le.',
  pending_token: 'Autorisation en attente : validez la demande sur l’écran de la Freebox.',
  no_token: 'Le panel n’est pas encore connecté à la Freebox.',
};

export class FreeboxError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
  }
}

export class Freebox {
  /**
   * @param {{ appToken?: string, httpsOnly?: boolean, onHttps?: () => void }} options
   *   httpsOnly : HTTPS a déjà fonctionné avec cette box (pas de retour en HTTP) ; onHttps : appelé quand c'est le cas.
   */
  constructor({ appToken = '', httpsOnly = false, onHttps = () => {} } = {}) {
    this.appToken = appToken;
    this.httpsOnly = httpsOnly;
    this.onHttps = onHttps;
    this.base = null;
    this.info = null;
    this.session = null;
    this.permissions = null;
  }

  origins() {
    if (process.env.ASTRA_FREEBOX_URL) return [process.env.ASTRA_FREEBOX_URL.replace(/\/+$/, '')];
    return this.httpsOnly ? [`https://${FREEBOX_HOST}`] : [`https://${FREEBOX_HOST}`, `http://${FREEBOX_HOST}`];
  }

  get host() {
    return new URL(this.origins()[0]).hostname;
  }

  // Version de l'API et modèle de la box ; null si aucune Freebox ne répond
  async discover({ timeout = 3000 } = {}) {
    if (this.info) return this.info;
    for (const origin of this.origins()) {
      try {
        const res = await lanRequest(`${origin}/api_version`, { ca: CA, timeout });
        const info = JSON.parse(res.text);
        if (res.status !== 200 || !info?.api_version) continue;
        const major = Number.parseInt(info.api_version, 10) || 4;
        this.info = info;
        this.base = `${origin}${info.api_base_url || '/api/'}v${major}/`;
        if (origin.startsWith('https:')) this.onHttps();
        return info;
      } catch {
        // pas de Freebox à cette adresse (ou certificat refusé) : adresse suivante
      }
    }
    return null;
  }

  // Nom lisible du modèle (« Freebox Server (r1) »…)
  get model() {
    return this.info?.box_model_name || this.info?.device_name || 'Freebox';
  }

  async call(method, path, body, { auth = true, retry = true } = {}) {
    if (!this.base && !(await this.discover())) throw new FreeboxError('Aucune Freebox ne répond sur le réseau local (mafreebox.freebox.fr)', 'not_found');
    if (auth && !this.session) await this.login();
    const res = await lanRequest(this.base + path, {
      method,
      ca: CA,
      headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Fbx-App-Auth': this.session } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new FreeboxError(`Réponse inattendue de la Freebox (HTTP ${res.status})`);
    }
    if (data.success) return data.result;
    // session expirée : nouvelle session, une fois
    if (auth && retry && (data.error_code === 'auth_required' || data.error_code === 'invalid_session')) {
      this.session = null;
      return this.call(method, path, body, { auth, retry: false });
    }
    throw new FreeboxError(MESSAGES[data.error_code] || `Freebox : ${data.msg || data.error_code || `erreur HTTP ${res.status}`}`, data.error_code);
  }

  // Demande d'autorisation : à valider sur l'écran de la Freebox. Retourne { appToken, trackId }.
  async authorize({ appName = 'AstraPanel', appVersion = '1', deviceName = 'AstraPanel' } = {}) {
    const r = await this.call(
      'POST',
      'login/authorize/',
      { app_id: FREEBOX_APP_ID, app_name: appName, app_version: appVersion, device_name: deviceName },
      { auth: false },
    );
    if (!r?.app_token || r.track_id === undefined) throw new FreeboxError('La Freebox n’a pas répondu à la demande d’autorisation');
    this.appToken = r.app_token;
    this.session = null;
    return { appToken: r.app_token, trackId: r.track_id };
  }

  // État de la demande : pending (en attente), granted (acceptée), denied (refusée), timeout, unknown (jeton invalide)
  async authorizationStatus(trackId) {
    const r = await this.call('GET', `login/authorize/${encodeURIComponent(trackId)}`, undefined, { auth: false });
    return r?.status || 'unknown';
  }

  async login() {
    if (!this.appToken) throw new FreeboxError(MESSAGES.no_token, 'no_token');
    const { challenge } = await this.call('GET', 'login/', undefined, { auth: false });
    const password = crypto.createHmac('sha1', this.appToken).update(String(challenge)).digest('hex');
    const r = await this.call('POST', 'login/session/', { app_id: FREEBOX_APP_ID, password }, { auth: false });
    this.session = r.session_token;
    this.permissions = r.permissions || {};
    return r;
  }

  // Droit de modifier les réglages (redirections de ports) : accordé ou non dans Freebox OS.
  // Nouvelle session à chaque fois : les droits d'une session ne changent pas après coup.
  async canChangeSettings() {
    await this.login();
    return Boolean(this.permissions?.settings);
  }

  async redirections() {
    return (await this.call('GET', 'fw/redir/')) || [];
  }
  addRedirection(r) {
    return this.call('POST', 'fw/redir/', r);
  }
  updateRedirection(id, r) {
    return this.call('PUT', `fw/redir/${encodeURIComponent(id)}`, r);
  }
  deleteRedirection(id) {
    return this.call('DELETE', `fw/redir/${encodeURIComponent(id)}`);
  }
  // État de la connexion : adresse IPv4 publique (ipv4) et, si l'IPv4 est partagée, les ports utilisables (ipv4_port_range)
  connection() {
    return this.call('GET', 'connection/');
  }
}
