import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { guessOperator } from '../src/nat/index.js';
import { startTestPanel } from './helpers.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const readBody = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => resolve(body));
});

// Freebox simulée : API Freebox OS (autorisation, session HMAC, droits, redirections, connexion)
function fakeFreebox() {
  const box = {
    authStatus: 'pending',
    appToken: 'jeton-app-freebox-0123456789',
    challenge: 'defi-123',
    settingsRight: false,
    portRange: [0, 65535],
    redirs: [{ id: 1, enabled: true, ip_proto: 'tcp', wan_port_start: 8080, wan_port_end: 8080, lan_ip: '192.168.1.50', lan_port: 80, src_ip: '0.0.0.0', comment: 'NAS' }],
    nextId: 2,
    sessions: new Set(),
    authorizeBody: null,
  };
  box.server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    // découverte : réponse sans enveloppe « success »
    if (p === '/api_version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ box_model_name: 'Freebox v9 (r1)', api_base_url: '/api/', https_available: true, api_version: '15.0', device_name: 'Freebox Server' }));
    }
    const send = (result, ok = true, extra = {}) => {
      res.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { success: true, ...(result === undefined ? {} : { result }) } : { success: false, ...extra }));
    };
    if (!p.startsWith('/api/v15/')) return send(null, false, { error_code: 'invalid_request', msg: 'inconnu' });
    const route = p.slice('/api/v15/'.length);
    if (route === 'login/authorize/' && req.method === 'POST') {
      box.authorizeBody = JSON.parse(body);
      return send({ app_token: box.appToken, track_id: 7 });
    }
    if (route === 'login/authorize/7') return send({ status: box.authStatus, challenge: box.challenge });
    if (route === 'login/') return send({ logged_in: false, challenge: box.challenge });
    if (route === 'login/session/') {
      const { app_id: appId, password } = JSON.parse(body);
      const expected = crypto.createHmac('sha1', box.appToken).update(box.challenge).digest('hex');
      if (appId !== 'fr.astrapanel' || password !== expected) return send(null, false, { error_code: 'invalid_token', msg: 'mauvais mot de passe' });
      const token = crypto.randomBytes(8).toString('hex');
      box.sessions.add(token);
      return send({ session_token: token, permissions: { settings: box.settingsRight, explorer: true } });
    }
    if (!box.sessions.has(req.headers['x-fbx-app-auth'])) return send(null, false, { error_code: 'auth_required', msg: 'session' });
    if (route === 'connection/') return send({ state: 'up', ipv4: '203.0.113.9', ipv4_port_range: box.portRange });
    if (route === 'fw/redir/' && req.method === 'GET') return send(box.redirs.length ? box.redirs : undefined);
    const write = !box.settingsRight && req.method !== 'GET';
    if (write) return send(null, false, { error_code: 'insufficient_rights', msg: 'droits' });
    if (route === 'fw/redir/' && req.method === 'POST') {
      const r = { id: box.nextId++, ...JSON.parse(body) };
      box.redirs.push(r);
      return send(r);
    }
    const one = /^fw\/redir\/(\d+)$/.exec(route);
    if (one && req.method === 'PUT') {
      box.redirs = box.redirs.map((r) => (r.id === Number(one[1]) ? { ...r, ...JSON.parse(body) } : r));
      return send(box.redirs.find((r) => r.id === Number(one[1])));
    }
    if (one && req.method === 'DELETE') {
      box.redirs = box.redirs.filter((r) => r.id !== Number(one[1]));
      return send(undefined);
    }
    return send(null, false, { error_code: 'invalid_request', msg: route });
  });
  return box;
}

// Box UPnP simulée (Livebox) : description, puis service WANIPConnection en SOAP
function fakeUpnp() {
  const box = { mappings: [{ proto: 'TCP', port: 3389, lanIp: '192.168.1.60', lanPort: 3389, description: 'Bureau à distance' }], calls: [] };
  box.server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === '/rootDesc.xml') {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><friendlyName>Livebox 6</friendlyName><manufacturer>Sagemcom</manufacturer><modelName>Livebox</modelName>
        <deviceList><device><deviceList><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></deviceList></device></deviceList></device></root>`);
    }
    const action = /#(\w+)"/.exec(req.headers.soapaction || '')?.[1];
    box.calls.push(action);
    const arg = (name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1];
    const reply = (inner) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`);
    };
    const fault = (code, text) => {
      res.writeHead(500, { 'Content-Type': 'text/xml' });
      res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>${text}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
    };
    if (action === 'GetExternalIPAddress') return reply('<NewExternalIPAddress>198.51.100.4</NewExternalIPAddress>');
    if (action === 'GetGenericPortMappingEntry') {
      const m = box.mappings[Number(arg('NewPortMappingIndex'))];
      if (!m) return fault(713, 'SpecifiedArrayIndexInvalid');
      return reply(
        `<NewRemoteHost></NewRemoteHost><NewExternalPort>${m.port}</NewExternalPort><NewProtocol>${m.proto}</NewProtocol><NewInternalPort>${m.lanPort}</NewInternalPort><NewInternalClient>${m.lanIp}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>${m.description}</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration>`,
      );
    }
    if (action === 'AddPortMapping') {
      const port = Number(arg('NewExternalPort'));
      const proto = arg('NewProtocol');
      const other = box.mappings.find((m) => m.port === port && m.proto === proto);
      if (other && other.lanIp !== arg('NewInternalClient')) return fault(718, 'ConflictInMappingEntry');
      box.mappings = box.mappings.filter((m) => m !== other);
      box.mappings.push({ proto, port, lanIp: arg('NewInternalClient'), lanPort: Number(arg('NewInternalPort')), description: arg('NewPortMappingDescription') });
      return reply('');
    }
    if (action === 'DeletePortMapping') {
      box.mappings = box.mappings.filter((m) => !(m.port === Number(arg('NewExternalPort')) && m.proto === arg('NewProtocol')));
      return reply('');
    }
    return fault(401, 'Invalid Action');
  });
  return box;
}

const ENV = ['ASTRA_FREEBOX_URL', 'ASTRA_UPNP_LOCATION', 'ASTRA_PUBLIC_IP_URL', 'ASTRA_PAPER_API', 'ASTRA_ADOPTIUM_API'];
function setEnv(t, values) {
  const before = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { ASTRA_PAPER_API: 'http://127.0.0.1:9/', ASTRA_ADOPTIUM_API: 'http://127.0.0.1:9/', ...values });
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('opérateur deviné d’après la box ou le nom inverse de l’adresse IP', () => {
  assert.equal(guessOperator('Freebox Server'), 'free');
  assert.equal(guessOperator('lns-bzn-12-82-64-1-2.adsl.proxad.net'), 'free');
  assert.equal(guessOperator('Sagemcom Livebox 6'), 'orange');
  assert.equal(guessOperator('amontsouris-123.w90-2.abo.wanadoo.fr'), 'orange');
  assert.equal(guessOperator('Bbox Fibre'), 'bouygues');
  assert.equal(guessOperator('box de SFR NB6VAC'), 'sfr');
  assert.equal(guessOperator('109.x.sfr.net'), 'sfr');
  assert.equal(guessOperator('FRITZ!Box 7590'), null);
});

test('Gestion de PORT avec une Freebox : détection, autorisation, droits, redirections, IPv4 partagée, conflit, retrait', async (t) => {
  const box = fakeFreebox();
  const url = await listen(box.server);
  t.after(() => box.server.close());
  setEnv(t, { ASTRA_FREEBOX_URL: url, ASTRA_UPNP_LOCATION: 'none', ASTRA_PUBLIC_IP_URL: 'http://127.0.0.1:9/' });
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  await ctx.setupAdmin();

  // détection : Free, Freebox Ultra, méthode conseillée « API Freebox » ; rien n'est activé tout seul
  let res = await ctx.request('POST', '/api/ports/detect', { body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.detected.operator, 'free');
  assert.equal(res.data.detected.box, 'Freebox v9 (r1)');
  assert.equal(res.data.detected.method, 'freebox');
  assert.equal(res.data.enabled, false);
  assert.equal(res.data.effective, 'freebox');

  // une redirection ajoutée à la main + un serveur Minecraft (port 25570)
  res = await ctx.request('POST', '/api/ports/rules', { body: { name: 'Serveur vocal', proto: 'udp', port: 9987 } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  res = await ctx.request('POST', '/api/apps', { body: { name: 'Survie', type: 'minecraft', port: 25570, mc: { ramMin: 512, ramMax: 1024, eula: true } } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const appId = res.data.app.id;
  res = await ctx.request('POST', '/api/ports/rules', { body: { name: 'Doublon', proto: 'tcp', port: 25570 } });
  assert.equal(res.status, 409);
  for (const bad of [{ name: '', port: 80 }, { name: 'x', port: 70000 }, { name: 'x', port: 80, proto: 'icmp' }]) {
    assert.equal((await ctx.request('POST', '/api/ports/rules', { body: bad })).status, 400);
  }

  // activée sans connexion à la Freebox : erreur claire, rien sur la box
  res = await ctx.request('PATCH', '/api/ports', { body: { enabled: true } });
  assert.equal(res.data.sync.ok, false);
  assert.match(res.data.sync.error, /Connectez d’abord le panel à la Freebox/);
  assert.equal(box.redirs.length, 1);

  // autorisation : en attente (validation sur l'écran de la box), puis acceptée
  res = await ctx.request('POST', '/api/ports/freebox/authorize', { body: {} });
  assert.equal(res.data.pending, true);
  assert.equal(box.authorizeBody.app_id, 'fr.astrapanel');
  assert.equal(box.authorizeBody.app_name, 'AstraPanel');
  assert.equal((await ctx.request('GET', '/api/ports/freebox')).data.pending, true);
  box.authStatus = 'granted';
  res = await ctx.request('GET', '/api/ports/freebox');
  assert.equal(res.data.connected, true);
  // sans le droit « Modification des réglages » : expliqué, pas d'écriture
  assert.equal(res.data.rights, false);
  assert.match(res.data.rightsHelp, /Gestion des accès/);
  res = await ctx.request('POST', '/api/ports/sync', { body: {} });
  assert.equal(res.data.sync.routes.find((r) => r.appId === appId).status, 'error');
  assert.match(res.data.sync.routes.find((r) => r.appId === appId).message, /Modification des réglages de la Freebox/);
  // le jeton d'application ne sort jamais du panel
  assert.ok(!JSON.stringify((await ctx.request('GET', '/api/ports')).data).includes(box.appToken));

  // droit accordé : redirections créées vers cette machine, commentées « AstraPanel · … »
  box.settingsRight = true;
  res = await ctx.request('POST', '/api/ports/sync', { body: {} });
  assert.equal(res.data.sync.ok, true, JSON.stringify(res.data.sync));
  const ours = () => box.redirs.filter((r) => r.comment.startsWith('AstraPanel')).map((r) => [r.comment, r.ip_proto, r.wan_port_start, r.lan_port, r.lan_ip]).sort();
  assert.deepEqual(ours(), [
    ['AstraPanel · Serveur vocal', 'udp', 9987, 9987, '127.0.0.1'],
    ['AstraPanel · Survie', 'tcp', 25570, 25570, '127.0.0.1'],
  ]);
  assert.equal(res.data.sync.publicIp, '203.0.113.9');
  assert.ok(box.redirs.some((r) => r.comment === 'NAS'), 'les redirections des autres ne sont pas touchées');
  // l'onglet Paramètres du serveur sait que son port est ouvert
  res = await ctx.request('GET', `/api/minecraft/network?app=${appId}`);
  assert.equal(res.data.portForward.status, 'ok');
  assert.equal(res.data.portForward.method, 'freebox');

  // deuxième synchronisation : rien ne bouge (pas de doublon)
  await ctx.request('POST', '/api/ports/sync', { body: {} });
  assert.equal(ours().length, 2);

  // IPv4 partagée : port hors de la plage → expliqué
  box.portRange = [16384, 32767];
  res = await ctx.request('POST', '/api/ports/sync', { body: {} });
  const voice = res.data.sync.routes.find((r) => r.kind === 'custom');
  assert.equal(voice.status, 'error');
  assert.match(voice.message, /IPv4 partagée : seuls les ports 16384 à 32767/);
  assert.equal(res.data.sync.routes.find((r) => r.appId === appId).status, 'ok');
  box.portRange = [0, 65535];

  // conflit : le port 8080 est déjà redirigé (NAS) → signalé, puis remplacé à la demande
  res = await ctx.request('POST', '/api/ports/rules', { body: { name: 'Web perso', proto: 'tcp', port: 8080, lanPort: 3000 } });
  const web = res.data.sync.routes.find((r) => r.label === 'Web perso');
  assert.equal(web.status, 'conflict');
  assert.match(web.message, /déjà redirigé vers 192\.168\.1\.50:80 \(« NAS »\)/);
  res = await ctx.request('POST', '/api/ports/sync', { body: { replace: [web.key] } });
  assert.equal(res.data.sync.routes.find((r) => r.key === web.key).status, 'ok');
  assert.ok(!box.redirs.some((r) => r.comment === 'NAS'));

  // serveur fermé, règle retirée : leurs redirections disparaissent
  res = await ctx.request('PATCH', '/api/ports', { body: { skip: [appId] } });
  assert.equal(res.data.sync.routes.find((r) => r.appId === appId).status, 'closed');
  res = await ctx.request('DELETE', `/api/ports/rules/${res.data.rules.find((r) => r.name === 'Web perso').id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(ours(), [['AstraPanel · Serveur vocal', 'udp', 9987, 9987, '127.0.0.1']]);

  // désactivée : le panel retire ce qu'il avait créé
  res = await ctx.request('PATCH', '/api/ports', { body: { enabled: false } });
  assert.equal(res.status, 200);
  assert.deepEqual(ours(), []);
  assert.equal(res.data.sync.routes.find((r) => r.kind === 'custom').status, 'off');

  // réservé aux administrateurs
  await ctx.request('POST', '/api/users', { body: { username: 'bob', password: 'motdepasse123', role: 'user' } });
  ctx.setCookie('');
  await ctx.request('POST', '/api/auth/login', { body: { username: 'bob', password: 'motdepasse123' } });
  assert.equal((await ctx.request('GET', '/api/ports')).status, 403);
  assert.equal((await ctx.request('GET', `/api/minecraft/network?app=${appId}`)).data.portForward, null);
});

test('Gestion de PORT en UPnP (Livebox) : détection, ouverture, conflit, retrait, mode manuel', async (t) => {
  const box = fakeUpnp();
  const url = await listen(box.server);
  t.after(() => box.server.close());
  setEnv(t, { ASTRA_FREEBOX_URL: 'http://127.0.0.1:9', ASTRA_UPNP_LOCATION: `${url}/rootDesc.xml`, ASTRA_PUBLIC_IP_URL: 'http://127.0.0.1:9/' });
  const ctx = await startTestPanel();
  t.after(() => ctx.close());
  await ctx.setupAdmin();

  let res = await ctx.request('POST', '/api/ports/detect', { body: {} });
  assert.equal(res.data.detected.operator, 'orange');
  assert.equal(res.data.detected.box, 'Livebox 6');
  assert.equal(res.data.detected.method, 'upnp');
  assert.equal(res.data.detected.publicIp, '198.51.100.4');

  await ctx.request('POST', '/api/ports/rules', { body: { name: 'Jeu', proto: 'both', port: 27015 } });
  await ctx.request('POST', '/api/ports/rules', { body: { name: 'Bureau', proto: 'tcp', port: 3389 } });
  res = await ctx.request('PATCH', '/api/ports', { body: { enabled: true } });
  const routes = Object.fromEntries(res.data.sync.routes.map((r) => [r.label, r]));
  assert.equal(routes.Jeu.status, 'ok', JSON.stringify(routes.Jeu));
  assert.equal(routes.Jeu.proto, 'both');
  assert.equal(routes.Bureau.status, 'conflict');
  assert.deepEqual(
    box.mappings.filter((m) => m.description.startsWith('AstraPanel')).map((m) => [m.proto, m.port, m.lanIp]).sort(),
    [['TCP', 27015, '127.0.0.1'], ['UDP', 27015, '127.0.0.1']],
  );

  // méthode « Manuel » : le panel retire ses redirections UPnP et indique quoi créer dans la box
  res = await ctx.request('PATCH', '/api/ports', { body: { method: 'manual' } });
  assert.equal(res.data.effective, 'manual');
  assert.ok(!box.mappings.some((m) => m.description.startsWith('AstraPanel')));
  assert.equal(res.data.sync.routes.find((r) => r.label === 'Jeu').status, 'manual');
  assert.ok(res.data.sync.lanIp);
  assert.equal((await ctx.request('PATCH', '/api/ports', { body: { method: 'magie' } })).status, 400);
});
