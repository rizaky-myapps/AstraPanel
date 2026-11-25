import { HttpError } from './http/util.js';

// Nom d'hôte publié par le tunnel Cloudflare : « monsite.fr », « api.monsite.fr », « *.monsite.fr »
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// Accepte une liste ou une chaîne (« a.fr, www.a.fr ») ; « https://a.fr/ » est ramené à « a.fr ».
export function normalizeDomains(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const out = [];
  for (const raw of list) {
    const domain = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!domain) continue;
    if (domain.length > 253 || !HOST_RE.test(domain)) {
      throw new HttpError(400, `Domaine invalide : ${domain} (exemple attendu : monsite.fr ou api.monsite.fr)`);
    }
    if (!out.includes(domain)) out.push(domain);
  }
  if (out.length > 20) throw new HttpError(400, '20 domaines maximum par application');
  return out;
}

// Un domaine ne peut appartenir qu'à une seule application (ou au panel).
export function assertDomainsFree(store, domains, exceptAppId = null) {
  const { apps, settings } = store.data;
  for (const domain of domains) {
    if (settings.panelDomain && settings.panelDomain === domain) {
      throw new HttpError(409, `Le domaine ${domain} est déjà utilisé par le panel`);
    }
    const other = apps.find((a) => a.id !== exceptAppId && a.domains?.includes(domain));
    if (other) throw new HttpError(409, `Le domaine ${domain} est déjà utilisé par « ${other.name} »`);
  }
}
