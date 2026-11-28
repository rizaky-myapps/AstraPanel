import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

const MAX_BODY = 2 * 1024 * 1024;

// Requête HTTP(S) vers un appareil du réseau local (box internet) : jamais via un proxy, délai court.
// ca : certificats racine acceptés (HTTPS de la Freebox). Retourne { status, headers, text }.
export function lanRequest(url, { method = 'GET', headers = {}, body, ca, timeout = 6000 } = {}) {
  const target = new URL(url);
  const mod = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      target,
      {
        method,
        agent: false,
        ca,
        timeout,
        headers: { ...headers, ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) req.destroy(new Error('réponse trop volumineuse'));
          else chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('pas de réponse (délai dépassé)')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Adresse IPv4 de cette machine sur le réseau local, celle qu'elle utilise pour joindre la box (host).
// Aucun paquet n'est envoyé : le système choisit seulement l'interface. À défaut : la première adresse privée.
export function localIpv4(host) {
  return new Promise((resolve) => {
    if (!host) return resolve(firstLanIpv4());
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (address) => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
        // déjà fermée
      }
      resolve(address && address !== '0.0.0.0' ? address : firstLanIpv4());
    };
    socket.on('error', () => finish(null));
    socket.connect(9, host, (err) => finish(err ? null : socket.address().address));
  });
}

export function firstLanIpv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
