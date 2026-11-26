import os from 'node:os';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile, statfs } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, value] of Object.entries(cpu.times)) {
      total += value;
      if (kind === 'idle' || kind === 'iowait') idle += value;
    }
  }
  return { idle, total };
}

// Échantillonnage CPU en continu pour avoir une valeur récente à chaque requête.
let previous = cpuTimes();
let cpuUsage = null;
setInterval(() => {
  const current = cpuTimes();
  const dTotal = current.total - previous.total;
  if (dTotal > 0) cpuUsage = Math.min(100, Math.max(0, 100 * (1 - (current.idle - previous.idle) / dTotal)));
  previous = current;
}, 2000).unref();

export const currentCpu = () => cpuUsage;

// Change à chaque démarrage de la machine : permet de distinguer un démarrage de la machine d'un redémarrage du panel.
export function bootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return null;
  }
}

async function readText(file) {
  try {
    return (await readFile(file, 'utf8')).replace(/\0/g, '').trim();
  } catch {
    return null;
  }
}

export async function memory() {
  const total = os.totalmem();
  let available = os.freemem();
  const meminfo = await readText('/proc/meminfo');
  const match = meminfo && /MemAvailable:\s+(\d+) kB/.exec(meminfo);
  if (match) available = Number(match[1]) * 1024;
  return { total, used: total - available, available };
}

// ---- Capteurs (température du processeur, ventilateurs) -------------------------------------------
// Lus dans /sys/class/hwmon (pilotes coretemp, k10temp, cpu_thermal…) ou, à défaut, dans les zones thermiques du
// noyau : fonctionne sur les PC, les serveurs comme sur les cartes ARM. Les chemins trouvés sont gardés en mémoire ;
// si rien n'est trouvé, on recherche de nouveau toutes les 5 minutes.
const CPU_SENSORS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'cpu-thermal', 'soc_thermal', 'scpi_sensors'];
const CPU_ZONE = /^(x86_pkg_temp|cpu|soc)/i;

let sensors = null;
let sensorsAt = 0;

const listDir = (dir) => readdir(dir).catch(() => []);

async function findSensors() {
  // dossiers modifiables pour les tests
  const HWMON = process.env.ASTRA_HWMON_DIR || '/sys/class/hwmon';
  const THERMAL = process.env.ASTRA_THERMAL_DIR || '/sys/class/thermal';
  const key = `${HWMON}|${THERMAL}`;
  if (sensors?.key === key && (sensors.temp || Date.now() - sensorsAt < 300_000)) return sensors;
  const found = { key, temp: null, fans: [] };
  let best = Infinity;
  for (const name of (await listDir(HWMON)).sort()) {
    const dir = `${HWMON}/${name}`;
    const rank = CPU_SENSORS.indexOf(await readText(`${dir}/name`));
    if (rank !== -1 && rank < best && (await readText(`${dir}/temp1_input`)) !== null) {
      best = rank;
      found.temp = `${dir}/temp1_input`;
    }
    for (const file of await listDir(dir)) if (/^fan\d+_input$/.test(file)) found.fans.push(`${dir}/${file}`);
  }
  if (!found.temp) {
    // zone thermique du processeur si on la reconnaît, sinon la première qui répond
    const zones = (await listDir(THERMAL))
      .filter((z) => /^thermal_zone\d+$/.test(z))
      .sort((a, b) => Number(a.slice(12)) - Number(b.slice(12)));
    let first = null;
    for (const zone of zones) {
      const file = `${THERMAL}/${zone}/temp`;
      if ((await readText(file)) === null) continue;
      first ||= file;
      if (CPU_ZONE.test((await readText(`${THERMAL}/${zone}/type`)) || '')) {
        found.temp = file;
        break;
      }
    }
    found.temp ||= first;
  }
  sensors = found;
  sensorsAt = Date.now();
  return found;
}

export async function temperature() {
  const { temp } = await findSensors();
  const raw = temp && (await readText(temp));
  if (temp && raw === null) sensors = null; // capteur disparu : nouvelle recherche au prochain appel
  return raw ? Number(raw) / 1000 : null;
}

// Vitesse du ventilateur le plus rapide (tr/min), ou null si la machine n'en signale aucun
export async function fanRpm() {
  const { fans } = await findSensors();
  const values = (await Promise.all(fans.map(readText))).filter((v) => v !== null && v !== '').map(Number);
  return values.length ? Math.max(...values) : null;
}

let throttleCache = { at: 0, value: null };
async function throttling() {
  if (Date.now() - throttleCache.at < 30000) return throttleCache.value;
  let value = null;
  try {
    const { stdout } = await execFileAsync('vcgencmd', ['get_throttled'], { timeout: 2000 });
    const bits = parseInt(stdout.split('=')[1], 16);
    if (!Number.isNaN(bits)) {
      value = {
        raw: `0x${bits.toString(16)}`,
        underVoltage: Boolean(bits & 0x1),
        throttled: Boolean(bits & 0x4),
        softTempLimit: Boolean(bits & 0x8),
        underVoltageOccurred: Boolean(bits & 0x10000),
        throttledOccurred: Boolean(bits & 0x40000),
      };
    }
  } catch {
    // outil absent sur cette machine, ou l'utilisateur n'est pas dans le groupe video
  }
  throttleCache = { at: Date.now(), value };
  return value;
}

export async function disk(dir) {
  try {
    const s = await statfs(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: total - free };
  } catch {
    return null;
  }
}

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (!addr.internal && addr.family === 'IPv4') out.push({ name, address: addr.address });
    }
  }
  return out;
}

// Modèle de la machine : arbre matériel des cartes ARM, sinon fabricant et modèle (DMI) des PC, serveurs et VPS
const DMI_PLACEHOLDER = /^(to be filled by o\.?e\.?m\.?|system (product name|manufacturer)|default string|not (specified|applicable)|none|o\.?e\.?m\.?|unknown)$/i;
export async function machineModel() {
  const tree = await readText('/proc/device-tree/model');
  if (tree) return tree;
  const dmi = process.env.ASTRA_DMI_DIR || '/sys/class/dmi/id';
  const clean = (value) => (value && !DMI_PLACEHOLDER.test(value) ? value : '');
  const [vendor, product, board] = (await Promise.all(['sys_vendor', 'product_name', 'board_name'].map((f) => readText(`${dmi}/${f}`)))).map(clean);
  const name = product || board;
  if (name) return vendor && !name.toLowerCase().startsWith(vendor.toLowerCase()) ? `${vendor} ${name}` : name;
  return `${os.type()} ${os.arch()}`;
}

let modelCache;
export async function systemInfo(dataDir) {
  modelCache ??= await machineModel();
  const [mem, temp, fan, throttle, diskInfo] = await Promise.all([
    memory(),
    temperature(),
    fanRpm(),
    throttling(),
    disk(dataDir),
  ]);
  return {
    hostname: os.hostname(),
    model: modelCache,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    uptime: os.uptime(),
    loadavg: os.loadavg(),
    cpus: os.cpus().length,
    cpu: cpuUsage,
    memory: mem,
    temperature: temp,
    fan,
    throttling: throttle,
    disk: diskInfo,
    addresses: addresses(),
  };
}
