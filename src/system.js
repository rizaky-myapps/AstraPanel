import os from 'node:os';
import { execFile } from 'node:child_process';
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

async function readText(file) {
  try {
    return (await readFile(file, 'utf8')).replace(/\0/g, '').trim();
  } catch {
    return null;
  }
}

async function memory() {
  const total = os.totalmem();
  let available = os.freemem();
  const meminfo = await readText('/proc/meminfo');
  const match = meminfo && /MemAvailable:\s+(\d+) kB/.exec(meminfo);
  if (match) available = Number(match[1]) * 1024;
  return { total, used: total - available, available };
}

async function temperature() {
  const raw = await readText('/sys/class/thermal/thermal_zone0/temp');
  return raw ? Number(raw) / 1000 : null;
}

// Ventilateur de l'Active Cooler du Raspberry Pi 5
async function fanRpm() {
  const base = '/sys/devices/platform/cooling_fan/hwmon';
  try {
    const [hwmon] = await readdir(base);
    const raw = hwmon && (await readText(`${base}/${hwmon}/fan1_input`));
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

// `vcgencmd get_throttled` : signale une alimentation insuffisante ou une surchauffe.
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
    // pas un Raspberry Pi, ou l'utilisateur n'est pas dans le groupe video
  }
  throttleCache = { at: Date.now(), value };
  return value;
}

async function disk(dir) {
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

let modelCache;
export async function systemInfo(dataDir) {
  modelCache ??= (await readText('/proc/device-tree/model')) || `${os.type()} ${os.arch()}`;
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
