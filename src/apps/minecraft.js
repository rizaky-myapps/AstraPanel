import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { HttpError } from '../http/util.js';

// Serveurs Minecraft (Java Edition) : Paper (recommandé, plus rapide, plugins) ou Vanilla (serveur officiel de Mojang).
// Le panel télécharge le serveur choisi et la version de Java qu'il demande (Eclipse Temurin, sans droits root), puis
// le lance avec la mémoire et les cœurs alloués.

const execFileAsync = promisify(execFile);
const api = () => ({
  paper: process.env.ASTRA_PAPER_API || 'https://fill.papermc.io/v3/projects/paper',
  mojang: process.env.ASTRA_MOJANG_MANIFEST || 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  adoptium: process.env.ASTRA_ADOPTIUM_API || 'https://api.adoptium.net/v3',
});
const HEADERS = { 'User-Agent': 'AstraPanel (https://github.com/rizaky-myapps/AstraPanel)' };

export const FLAVORS = {
  paper: { label: 'Paper', hint: 'recommandé : plus rapide, accepte les plugins' },
  vanilla: { label: 'Vanilla', hint: 'serveur officiel de Mojang' },
};
export const MC_PORT = 25565;
export const JAR = 'server.jar';
// Versions de Java proposées par Adoptium (LTS) : on prend la plus ancienne qui convient à la version de Minecraft
const JAVA_LTS = [8, 11, 17, 21, 25];

export const MC_DEFAULTS = { flavor: 'paper', version: 'latest', ramMin: 1024, ramMax: 2048, cores: 0, eula: false };

// Mémoire totale de la machine, en Mo (limite haute de la RAM allouée)
export const machineMemory = () => Math.floor(os.totalmem() / 1048576);
export const machineCores = () => os.availableParallelism?.() || os.cpus().length || 1;

// Valide les réglages d'un serveur Minecraft (création ou modification). `current` : réglages actuels.
export function cleanMinecraft(input = {}, current = MC_DEFAULTS) {
  const mc = { ...MC_DEFAULTS, ...current };
  if ('flavor' in input) {
    if (!FLAVORS[input.flavor]) throw new HttpError(400, 'Type de serveur Minecraft inconnu (paper ou vanilla)');
    mc.flavor = input.flavor;
  }
  if ('version' in input) {
    const v = String(input.version || 'latest').trim();
    if (v !== 'latest' && !/^[0-9][0-9a-z.+-]{0,30}$/i.test(v)) throw new HttpError(400, 'Version de Minecraft invalide');
    mc.version = v;
  }
  for (const key of ['ramMin', 'ramMax']) {
    if (key in input) {
      const n = Number(input[key]);
      if (!Number.isInteger(n) || n < 256 || n > 1048576) throw new HttpError(400, 'Mémoire invalide : entre 256 Mo et la mémoire de la machine');
      mc[key] = n;
    }
  }
  if (mc.ramMax > machineMemory()) throw new HttpError(400, `Mémoire maximale trop grande : la machine a ${machineMemory()} Mo`);
  if (mc.ramMin > mc.ramMax) throw new HttpError(400, 'La mémoire minimale doit être inférieure ou égale à la mémoire maximale');
  if ('cores' in input) {
    const n = Number(input.cores);
    if (!Number.isInteger(n) || n < 0 || n > machineCores()) throw new HttpError(400, `Nombre de cœurs invalide : 0 (tous) à ${machineCores()}`);
    mc.cores = n;
  }
  if ('eula' in input) mc.eula = input.eula === true;
  return mc;
}

async function getJson(url, signal) {
  const res = await fetch(url, { headers: HEADERS, signal: signal || AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} a répondu ${res.status}`);
  return res.json();
}

// ---- Versions disponibles ----------------------------------------------------------------------------
const cache = new Map(); // flavor -> { at, versions: [{ id, java }] }
const CACHE_FOR = 3600_000;
const stable = (id) => /^[0-9]+(\.[0-9]+)+$/.test(id);

export async function listVersions(flavor) {
  if (!FLAVORS[flavor]) throw new HttpError(400, 'Type de serveur Minecraft inconnu');
  const hit = cache.get(flavor);
  if (hit && Date.now() - hit.at < CACHE_FOR) return hit.versions;
  let versions;
  try {
    if (flavor === 'paper') {
      const data = await getJson(`${api().paper}/versions`);
      versions = (data.versions || [])
        .map((v) => ({ id: v.version?.id, java: v.version?.java?.version?.minimum ?? null }))
        .filter((v) => v.id && stable(v.id));
    } else {
      const data = await getJson(api().mojang);
      versions = (data.versions || []).filter((v) => v.type === 'release' && /^[0-9][0-9a-z.+-]{0,30}$/i.test(v.id)).map((v) => ({ id: v.id, java: null }));
    }
  } catch (err) {
    throw new HttpError(502, `Liste des versions de Minecraft indisponible : ${err.message}`);
  }
  // plus récente d'abord
  versions.sort((a, b) => compareMc(b.id, a.id));
  cache.set(flavor, { at: Date.now(), versions });
  return versions;
}

export function compareMc(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Java nécessaire quand l'API ne le dit pas (serveur Vanilla ancien)
export function javaFor(version) {
  if (compareMc(version, '26') >= 0) return 25;
  if (compareMc(version, '1.20.5') >= 0) return 21;
  if (compareMc(version, '1.18') >= 0) return 17;
  if (compareMc(version, '1.17') >= 0) return 16;
  return 8;
}
export const javaLts = (minimum) => JAVA_LTS.find((v) => v >= minimum) || JAVA_LTS.at(-1);

// Fichier serveur à télécharger pour un type et une version : { version, url, sha256 | sha1, java, label }
export async function resolveServer(flavor, wanted = 'latest', signal) {
  if (flavor === 'paper') {
    const versions = await listVersions('paper');
    const entry = wanted === 'latest' ? versions[0] : versions.find((v) => v.id === wanted);
    if (!entry) throw new Error(`Paper n’existe pas en version ${wanted}`);
    const build = await getJson(`${api().paper}/versions/${encodeURIComponent(entry.id)}/builds/latest`, signal);
    const file = build.downloads?.['server:default'];
    if (!file?.url) throw new Error(`aucun fichier serveur pour Paper ${entry.id}`);
    return { version: entry.id, build: build.id, url: file.url, sha256: file.checksums?.sha256 || null, java: entry.java || javaFor(entry.id), label: `Paper ${entry.id} (build ${build.id})` };
  }
  const manifest = await getJson(api().mojang, signal);
  const id = wanted === 'latest' ? manifest.latest?.release : wanted;
  const entry = (manifest.versions || []).find((v) => v.id === id);
  if (!entry) throw new Error(`Minecraft ${wanted} introuvable`);
  const meta = await getJson(entry.url, signal);
  const server = meta.downloads?.server;
  if (!server?.url) throw new Error(`pas de serveur officiel pour Minecraft ${id}`);
  return { version: id, build: null, url: server.url, sha1: server.sha1 || null, java: meta.javaVersion?.majorVersion || javaFor(id), label: `Minecraft ${id} (Vanilla)` };
}

// ---- Téléchargement avec progression et vérification ------------------------------------------------------
export async function download(url, file, { log, label, sha256 = null, sha1 = null, signal } = {}) {
  const res = await fetch(url, { headers: HEADERS, signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`téléchargement impossible (${res.status}) : ${label}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = sha256 ? crypto.createHash('sha256') : sha1 ? crypto.createHash('sha1') : null;
  const tmp = `${file}.part`;
  await mkdir(path.dirname(file), { recursive: true });
  const out = createWriteStream(tmp);
  let received = 0;
  let shown = -1;
  try {
    for await (const chunk of res.body) {
      received += chunk.length;
      hash?.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const pct = total ? Math.floor((received / total) * 10) * 10 : -1;
      if (pct > shown && pct >= 0) {
        shown = pct;
        log?.system(`  ${label} : ${pct} % (${(received / 1048576).toFixed(1)} Mo)`);
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await rm(tmp, { force: true });
    throw err;
  }
  const digest = hash?.digest('hex');
  if (digest && digest !== (sha256 || sha1).toLowerCase()) {
    await rm(tmp, { force: true });
    throw new Error(`fichier corrompu (empreinte incorrecte) : ${label}`);
  }
  await rename(tmp, file);
  return received;
}

// ---- Java (Eclipse Temurin, dans le dossier de données du panel) ---------------------------------------------
export const javaHome = (runtimeDir, major) => path.join(runtimeDir, `java-${major}`);
export const javaBin = (runtimeDir, major) => path.join(javaHome(runtimeDir, major), 'bin', 'java');

export async function ensureJava(runtimeDir, minimum, { log, signal } = {}) {
  const major = javaLts(minimum);
  const bin = javaBin(runtimeDir, major);
  if (existsSync(bin)) {
    log?.system(`Java ${major} déjà installé`);
    return { major, bin };
  }
  const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
  if (!arch) throw new Error(`processeur ${process.arch} non pris en charge par Java (x64 ou ARM 64 bits)`);
  log?.system(`Installation de Java ${major} (Eclipse Temurin, ${arch})…`);
  const assets = await getJson(`${api().adoptium}/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jre&os=linux&vendor=eclipse`, signal);
  const pkg = assets?.[0]?.binary?.package;
  if (!pkg?.link) throw new Error(`Java ${major} introuvable chez Adoptium pour ce processeur`);
  const archive = path.join(runtimeDir, `java-${major}.tar.gz`);
  const home = javaHome(runtimeDir, major);
  await download(pkg.link, archive, { log, label: `Java ${major}`, sha256: pkg.checksum || null, signal });
  const tmp = `${home}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    await execFileAsync('tar', ['-xzf', archive, '-C', tmp, '--strip-components=1'], { timeout: 5 * 60_000 });
    await rm(home, { recursive: true, force: true });
    await rename(tmp, home);
  } finally {
    await rm(archive, { force: true });
    await rm(tmp, { recursive: true, force: true });
  }
  if (!existsSync(bin)) throw new Error(`Java ${major} : archive inattendue`);
  log?.system(`✔ Java ${major} installé`);
  return { major, bin };
}

// ---- Fichiers du serveur ----------------------------------------------------------------------------------
// eula.txt : obligatoire pour que le serveur démarre (accepté à la création, CLUF de Minecraft)
export async function writeEula(dir, accepted) {
  await writeFile(
    path.join(dir, 'eula.txt'),
    `# CLUF de Minecraft (https://aka.ms/MinecraftEULA), accepté dans AstraPanel le ${new Date().toISOString()}\neula=${accepted ? 'true' : 'false'}\n`,
  );
}

// server.properties : le port attribué par le panel (le reste est réglé par le serveur, modifiable dans Fichiers)
export async function setServerPort(dir, port) {
  const file = path.join(dir, 'server.properties');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    text = '#Minecraft server properties\n';
  }
  const line = `server-port=${port}`;
  text = /^server-port=.*$/m.test(text) ? text.replace(/^server-port=.*$/m, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  await writeFile(file, text);
}

// Commande de lancement : mémoire min / max, cœurs alloués (affinité processeur + vue de la JVM)
export function launchCommand(java, mc, { taskset = '/usr/bin/taskset', flavor = mc.flavor } = {}) {
  const cores = Math.min(mc.cores || 0, machineCores());
  const jvm = [`-Xms${mc.ramMin}M`, `-Xmx${mc.ramMax}M`];
  if (cores) jvm.push(`-XX:ActiveProcessorCount=${cores}`);
  // réglages recommandés par Paper (ramasse-miettes G1), utiles aussi pour Vanilla
  jvm.push('-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch');
  // console sans terminal : pas de saisie interactive (jline), mais les couleurs des journaux (affichées par le panel)
  jvm.push('-Dterminal.jline=false', '-Dterminal.ansi=true');
  const args = [...jvm, '-jar', JAR, flavor === 'vanilla' ? 'nogui' : '--nogui'];
  if (cores && existsSync(taskset)) return { command: taskset, args: ['-c', `0-${cores - 1}`, java, ...args] };
  return { command: java, args };
}
