import path from 'node:path';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { HttpError } from '../http/util.js';

function isInside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Résout un chemin relatif à l'intérieur du dossier d'une app, en refusant toute sortie
 * (../, chemins absolus, liens symboliques qui pointent ailleurs).
 */
export async function resolveInside(root, rel = '', { mustExist = false } = {}) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new HttpError(400, 'Chemin invalide');
  const realRoot = await realpath(root);
  const target = path.resolve(realRoot, '.' + path.sep + rel.replace(/\\/g, '/'));
  if (!isInside(realRoot, target)) throw new HttpError(400, 'Chemin en dehors du dossier de l’application');

  // On vérifie le chemin réel du plus proche parent existant.
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!isInside(realRoot, real)) throw new HttpError(400, 'Chemin en dehors du dossier de l’application');
      break;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err.code !== 'ENOENT') throw err;
      if (mustExist && probe === target) throw new HttpError(404, 'Fichier introuvable');
      probe = path.dirname(probe);
    }
  }
  return { root: realRoot, target, rel: path.relative(realRoot, target).split(path.sep).join('/') };
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new HttpError(400, 'Nom de fichier invalide');
  }
  if (name.length > 255) throw new HttpError(400, 'Nom trop long');
}

export async function listDir(root, rel) {
  const { target, rel: cleanRel } = await resolveInside(root, rel, { mustExist: true });
  const info = await stat(target);
  if (!info.isDirectory()) throw new HttpError(400, 'Ce chemin n’est pas un dossier');
  const names = await readdir(target);
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const l = await lstat(path.join(target, name));
        let type = l.isDirectory() ? 'dir' : 'file';
        if (l.isSymbolicLink()) {
          const s = await stat(path.join(target, name)).catch(() => null);
          type = s?.isDirectory() ? 'dir' : 'file';
        }
        return { name, type, size: l.size, mtime: l.mtimeMs, link: l.isSymbolicLink() };
      } catch {
        return null;
      }
    }),
  );
  return {
    path: cleanRel,
    entries: entries
      .filter(Boolean)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)),
  };
}

export async function readTextFile(root, rel, maxBytes) {
  const { target } = await resolveInside(root, rel, { mustExist: true });
  const info = await stat(target);
  if (!info.isFile()) throw new HttpError(400, 'Ce chemin n’est pas un fichier');
  if (info.size > maxBytes) {
    throw new HttpError(413, `Fichier trop gros pour l'éditeur (${Math.round(maxBytes / 1024 / 1024)} Mo max). Téléchargez-le.`);
  }
  const buf = await readFile(target);
  if (buf.subarray(0, 8000).includes(0)) throw new HttpError(415, 'Fichier binaire : téléchargez-le pour l’ouvrir');
  return { content: buf.toString('utf8'), size: info.size, mtime: info.mtimeMs };
}

export async function writeTextFile(root, rel, content) {
  if (typeof content !== 'string') throw new HttpError(400, 'Contenu invalide');
  const { target, root: realRoot } = await resolveInside(root, rel);
  if (target === realRoot) throw new HttpError(400, 'Chemin invalide');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

export async function makeDir(root, rel) {
  const { target, root: realRoot } = await resolveInside(root, rel);
  if (target === realRoot) throw new HttpError(400, 'Chemin invalide');
  await mkdir(target, { recursive: true });
}

export async function removePath(root, rel) {
  const { target, root: realRoot } = await resolveInside(root, rel, { mustExist: true });
  if (target === realRoot) throw new HttpError(400, 'Impossible de supprimer le dossier racine');
  await rm(target, { recursive: true, force: true });
}

export async function renamePath(root, fromRel, toRel) {
  const from = await resolveInside(root, fromRel, { mustExist: true });
  const to = await resolveInside(root, toRel);
  if (from.target === from.root || to.target === to.root) throw new HttpError(400, 'Chemin invalide');
  validateName(path.basename(to.target));
  const exists = await lstat(to.target).then(() => true, () => false);
  if (exists) throw new HttpError(409, 'Un fichier porte déjà ce nom');
  await mkdir(path.dirname(to.target), { recursive: true });
  await rename(from.target, to.target);
}

export async function uploadTarget(root, dirRel, name) {
  validateName(name);
  const dir = await resolveInside(root, dirRel);
  await mkdir(dir.target, { recursive: true });
  const { target } = await resolveInside(root, path.posix.join(dir.rel, name));
  return target;
}

export async function downloadInfo(root, rel) {
  const { target } = await resolveInside(root, rel, { mustExist: true });
  const info = await stat(target);
  if (!info.isFile()) throw new HttpError(400, 'Seuls les fichiers peuvent être téléchargés');
  return { file: target, size: info.size, name: path.basename(target) };
}
