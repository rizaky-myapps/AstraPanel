import dgram from 'node:dgram';
import { lanRequest } from './lan.js';

// UPnP IGD : la plupart des box (Livebox, Bbox, box SFR, Freebox…) laissent les machines du réseau ouvrir
// leurs propres ports, si l'option UPnP est activée dans la box. Aucun jeton : découverte par SSDP (multicast),
// puis requêtes SOAP vers le service WANIPConnection (ou WANPPPConnection) de la box.
// ASTRA_UPNP_LOCATION : adresse de la description de la box (tests), « none » pour ne pas chercher.
const SSDP = { host: '239.255.255.250', port: 1900 };
const TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
];
const SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

const unescapeXml = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const escapeXml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const tag = (xml, name) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml);
  return m ? unescapeXml(m[1].trim()) : '';
};

export class UpnpError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
  }
}

// Adresses (LOCATION) des box qui répondent à la recherche SSDP
export function ssdpSearch(timeout = 2500) {
  return new Promise((resolve) => {
    const found = new Set();
    let socket;
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      return resolve([]);
    }
    const end = () => {
      try {
        socket.close();
      } catch {
        // déjà fermée
      }
      resolve([...found]);
    };
    socket.on('error', end);
    socket.on('message', (msg) => {
      const location = /^location:\s*(\S+)/im.exec(msg.toString())?.[1];
      if (location && /^https?:\/\//.test(location)) found.add(location);
    });
    socket.bind(() => {
      for (const st of TARGETS) {
        const query = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP.host}:${SSDP.port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        socket.send(query, SSDP.port, SSDP.host, () => {});
      }
      setTimeout(end, timeout);
    });
  });
}

export class UpnpGateway {
  constructor({ location, info, controlUrl, serviceType }) {
    this.location = location;
    this.info = info; // { manufacturer, modelName, friendlyName, modelDescription }
    this.controlUrl = controlUrl;
    this.serviceType = serviceType;
  }

  get host() {
    return new URL(this.location).hostname;
  }

  get model() {
    const { friendlyName, modelName, manufacturer } = this.info;
    return friendlyName || [manufacturer, modelName].filter(Boolean).join(' ') || 'Box UPnP';
  }

  // Lit la description de la box et trouve son service de redirection de ports
  static async fromLocation(location) {
    const res = await lanRequest(location, { timeout: 4000 });
    if (res.status !== 200) throw new UpnpError(`description UPnP illisible (HTTP ${res.status})`);
    const xml = res.text;
    const info = {
      manufacturer: tag(xml, 'manufacturer'),
      modelName: tag(xml, 'modelName'),
      friendlyName: tag(xml, 'friendlyName'),
      modelDescription: tag(xml, 'modelDescription'),
    };
    const services = [...xml.matchAll(/<(?:[\w-]+:)?service>([\s\S]*?)<\/(?:[\w-]+:)?service>/g)].map((m) => ({ type: tag(m[1], 'serviceType'), control: tag(m[1], 'controlURL') }));
    const service = SERVICES.map((type) => services.find((s) => s.type === type && s.control)).find(Boolean);
    if (!service) throw new UpnpError('la box ne propose pas l’ouverture de ports par UPnP');
    const base = tag(xml, 'URLBase') || location;
    return new UpnpGateway({ location, info, controlUrl: new URL(service.control, base).href, serviceType: service.type });
  }

  // Box du réseau local (la première qui sait ouvrir des ports), ou null
  static async find({ timeout = 2500 } = {}) {
    const forced = process.env.ASTRA_UPNP_LOCATION;
    if (forced === 'none') return null;
    const locations = forced ? [forced] : await ssdpSearch(timeout);
    for (const location of locations) {
      try {
        return await UpnpGateway.fromLocation(location);
      } catch {
        // appareil UPnP qui n'est pas une box (télévision, NAS…) : suivant
      }
    }
    return null;
  }

  async action(name, args = {}) {
    const body =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
      `<u:${name} xmlns:u="${this.serviceType}">` +
      Object.entries(args)
        .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
        .join('') +
      `</u:${name}></s:Body></s:Envelope>`;
    const res = await lanRequest(this.controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${this.serviceType}#${name}"` },
      body,
    });
    if (res.status !== 200) {
      const code = Number(tag(res.text, 'errorCode')) || null;
      throw new UpnpError(tag(res.text, 'errorDescription') || `refus de la box (HTTP ${res.status})`, code);
    }
    const out = {};
    for (const m of res.text.matchAll(/<(New\w+)>([\s\S]*?)<\/\1>/g)) out[m[1]] = unescapeXml(m[2]);
    return out;
  }

  async externalIp() {
    return (await this.action('GetExternalIPAddress')).NewExternalIPAddress || null;
  }

  // Redirections actuelles de la box : { proto, port, lanIp, lanPort, enabled, description }
  async mappings() {
    const list = [];
    for (let i = 0; i < 256; i++) {
      let e;
      try {
        e = await this.action('GetGenericPortMappingEntry', { NewPortMappingIndex: i });
      } catch {
        break; // fin de la liste (erreur 713)
      }
      list.push({
        proto: String(e.NewProtocol || '').toLowerCase(),
        port: Number(e.NewExternalPort),
        lanIp: e.NewInternalClient,
        lanPort: Number(e.NewInternalPort),
        enabled: e.NewEnabled !== '0',
        description: e.NewPortMappingDescription || '',
      });
    }
    return list;
  }

  async add({ proto, port, lanIp, lanPort, description }) {
    const args = (lease) => ({
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: proto.toUpperCase(),
      NewInternalPort: lanPort,
      NewInternalClient: lanIp,
      NewEnabled: 1,
      NewPortMappingDescription: description,
      NewLeaseDuration: lease,
    });
    try {
      await this.action('AddPortMapping', args(0));
    } catch (err) {
      // 718 : port déjà pris par une autre machine ; sinon, certaines box refusent les redirections sans fin :
      // une semaine (le panel les renouvelle bien avant)
      if (err.code === 718) throw new UpnpError('port déjà redirigé vers une autre machine', 718);
      await this.action('AddPortMapping', args(7 * 24 * 3600));
    }
  }

  remove({ proto, port }) {
    return this.action('DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: proto.toUpperCase() });
  }
}
