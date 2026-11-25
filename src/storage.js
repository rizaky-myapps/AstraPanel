import path from 'node:path';
import { execFile } from 'node:child_process';
import { lstat, readFile, statfs } from 'node:fs/promises';
import { HttpError } from './http/util.js';

// Systèmes de fichiers « réels » (on ignore proc, tmpfs, overlay, squashfs des snaps…)
const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'zfs']);
const CACHE_TTL = 5 * 60_000;
const MAX_ENTRIES = 300;

const unescapeMount = (s) => s.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));

// Emplacements de stockage : un par périphérique (le point de montage le plus court l'emporte).
export async function listMounts() {
  const text = await readFile('/proc/mounts', 'utf8').catch(() => '');
  const byDevice = new Map();
  for (const line of text.split('\n')) {
    const [device, rawMount, fstype] = line.split(' ');
    if (!device || !REAL_FS.has(fstype) || device.startsWith('/dev/loop')) continue;
    const mount = unescapeMount(rawMount);
    const known = byDevice.get(device);
    if (!known || mount.length < known.mount.length) byDevice.set(device, { device, mount, fstype });
  }
  const out = [];
  for (const m of byDevice.values()) {
    try {
      const s = await statfs(m.mount);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      out.push({ ...m, total, free, used: total - free });
    } catch {
      // point de montage inaccessible
    }
  }
  return out.sort((a, b) => a.mount.localeCompare(b.mount));
}

const cache = new Map();
const inflight = new Map();

function runDu(dir) {
  return new Promise((resolve) => {
    // -x : reste sur le même disque ; -a -d1 : fichiers et dossiers du niveau courant ; nice : basse priorité
    execFile(
      'nice',
      ['-n', '10', 'du', '-x', '-a', '-d', '1', '-B1', '--', dir],
      { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000 },
      (err, stdout, stderr) => {
        // du renvoie un code d'erreur dès qu'un dossier est illisible : la sortie reste exploitable
        resolve({ stdout: stdout || '', stderr: stderr || '', failed: Boolean(err) && !stdout });
      },
    );
  });
}

/**
 * Contenu d'un dossier trié par taille (taille réelle sur le disque, sous-dossiers compris).
 * Les dossiers que le panel n'a pas le droit de lire sont comptés et signalés.
 */
export async function analyze(dir, { refresh = false } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) throw new HttpError(400, 'Chemin invalide');
  const target = path.resolve(dir);
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory()) throw new HttpError(404, 'Dossier introuvable');

  const cached = cache.get(target);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL) return cached.result;
  if (!inflight.has(target)) {
    inflight.set(
      target,
      runDu(target)
        .then(async ({ stdout, stderr, failed }) => {
          if (failed) throw new HttpError(500, stderr.trim().split('\n')[0] || 'Analyse impossible');
          const entries = [];
          let total = 0;
          for (const line of stdout.split('\n')) {
            const tab = line.indexOf('\t');
            if (tab < 0) continue;
            const size = Number(line.slice(0, tab));
            const p = line.slice(tab + 1);
            if (p === target) {
              total = size;
              continue;
            }
            entries.push({ path: p, name: path.basename(p), size });
          }
          entries.sort((a, b) => b.size - a.size);
          const shown = entries.slice(0, MAX_ENTRIES);
          await Promise.all(
            shown.map(async (e) => {
              const l = await lstat(e.path).catch(() => null);
              e.type = l?.isDirectory() ? 'dir' : l?.isSymbolicLink() ? 'link' : 'file';
            }),
          );
          const denied = stderr.split('\n').filter((l) => /Permission denied|Permission non accordée/i.test(l)).length;
          const result = {
            path: target,
            parent: target === '/' ? null : path.dirname(target),
            total,
            entries: shown,
            hidden: entries.length - shown.length,
            hiddenSize: entries.slice(MAX_ENTRIES).reduce((sum, e) => sum + e.size, 0),
            denied,
            at: Date.now(),
          };
          cache.set(target, { at: Date.now(), result });
          return result;
        })
        .finally(() => inflight.delete(target)),
    );
  }
  return inflight.get(target);
}
