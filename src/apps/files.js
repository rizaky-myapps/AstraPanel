import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { HttpError } from '../http/util.js';

const execFileAsync = promisify(execFile);
const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.xz|tar\.bz2)$/i;

function isInside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Résout un chemin relatif à l'intérieur du dossier d'une app, en refusant toute sortie
 * (../, chemins absolus, liens symboliques qui pointent ailleurs).
 * noFollowLast : l'élément lui-même n'est pas suivi s'il s'agit d'un lien (pour le supprimer,
 * le renommer ou l'archiver tel quel) ; seul son dossier parent doit être dans l'application.
 */
export async function resolveInside(root, rel = '', { mustExist = false, noFollowLast = false } = {}) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new HttpError(400, 'Chemin invalide');
  const realRoot = await realpath(root);
  const target = path.resolve(realRoot, '.' + path.sep + rel.replace(/\\/g, '/'));
  if (!isInside(realRoot, target)) throw new HttpError(400, 'Chemin en dehors du dossier de l’application');

  if (noFollowLast && target !== realRoot) {
    await resolveInside(realRoot, path.relative(realRoot, path.dirname(target)));
    if (mustExist && !(await lstat(target).then(() => true, () => false))) throw new HttpError(404, 'Fichier introuvable');
    return { root: realRoot, target, rel: path.relative(realRoot, target).split(path.sep).join('/') };
  }

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

// Propriétés d'un fichier ou d'un dossier (pour un dossier : taille totale et nombre d'éléments, parcours limité).
const STAT_LIMIT = 20_000;
export async function statPath(root, rel) {
  const { target, rel: cleanRel } = await resolveInside(root, rel, { mustExist: true });
  const l = await lstat(target);
  const info = l.isSymbolicLink() ? await stat(target).catch(() => l) : l;
  const out = {
    name: cleanRel ? path.basename(cleanRel) : '',
    path: cleanRel,
    type: info.isDirectory() ? 'dir' : 'file',
    link: l.isSymbolicLink(),
    size: info.isDirectory() ? 0 : info.size,
    mtime: info.mtimeMs,
    ctime: info.birthtimeMs || info.ctimeMs,
    mode: (info.mode & 0o777).toString(8).padStart(3, '0'),
  };
  if (out.type === 'dir') {
    let files = 0;
    let dirs = 0;
    let seen = 0;
    let partial = false;
    const walk = async (dir) => {
      let names;
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (++seen > STAT_LIMIT) {
          partial = true;
          return;
        }
        const s = await lstat(path.join(dir, name)).catch(() => null);
        if (!s) continue;
        if (s.isDirectory()) {
          dirs++;
          await walk(path.join(dir, name));
          if (partial) return;
        } else {
          files++;
          out.size += s.size;
        }
      }
    };
    await walk(target);
    Object.assign(out, { files, dirs, partial });
  }
  return out;
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
  const { target, root: realRoot } = await resolveInside(root, rel, { mustExist: true, noFollowLast: true });
  if (target === realRoot) throw new HttpError(400, 'Impossible de supprimer le dossier racine');
  await rm(target, { recursive: true, force: true });
}

export async function renamePath(root, fromRel, toRel) {
  const from = await resolveInside(root, fromRel, { mustExist: true, noFollowLast: true });
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

const exists = (p) => lstat(p).then(() => true, () => false);

// « photo.png » -> « photo (2).png » si le nom est déjà pris dans le dossier.
async function uniqueTarget(dir, name) {
  let target = path.join(dir, name);
  if (!(await exists(target))) return target;
  const match = /^(.*?)((?:\.tar)?\.[^.]+)?$/.exec(name);
  const base = match[1] || name;
  const ext = match[2] || '';
  for (let i = 2; i < 1000; i++) {
    target = path.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(target))) return target;
  }
  throw new HttpError(409, 'Impossible de trouver un nom libre');
}

function validatePaths(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'Aucun élément sélectionné');
  if (paths.length > 1000) throw new HttpError(400, 'Trop d’éléments sélectionnés');
  return paths;
}

// Supprime tout ce qui peut l'être ; les éléments déjà absents sont ignorés.
export async function removePaths(root, paths) {
  const failed = [];
  for (const rel of validatePaths(paths)) {
    try {
      await removePath(root, rel);
    } catch (err) {
      if (err.status !== 404) failed.push(`${path.basename(rel)} (${err.message})`);
    }
  }
  if (failed.length) throw new HttpError(400, `Non supprimé : ${failed.join(', ')}`);
}

// Déplace ou copie des éléments dans un dossier (les doublons de nom sont renommés).
export async function transferPaths(root, paths, destRel, mode) {
  const dest = await resolveInside(root, destRel);
  await mkdir(dest.target, { recursive: true });
  const realDest = await realpath(dest.target);
  const done = [];
  for (const rel of validatePaths(paths)) {
    const src = await resolveInside(root, rel, { mustExist: true, noFollowLast: true });
    if (src.target === src.root) throw new HttpError(400, 'Impossible de déplacer le dossier racine');
    if (isInside(src.target, realDest)) throw new HttpError(400, `« ${path.basename(src.target)} » ne peut pas être placé dans lui-même`);
    if (mode === 'move' && path.dirname(src.target) === realDest) continue;
    const target = await uniqueTarget(realDest, path.basename(src.target));
    if (mode === 'move') await rename(src.target, target);
    else await cp(src.target, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    done.push(path.basename(target));
  }
  return done;
}

// Compresse des éléments d'un même dossier dans une archive ZIP créée à côté d'eux.
export async function compressPaths(root, dirRel, names, archiveName) {
  const dir = await resolveInside(root, dirRel, { mustExist: true });
  validatePaths(names);
  for (const name of names) {
    validateName(name);
    await resolveInside(root, path.posix.join(dir.rel, name), { mustExist: true, noFollowLast: true });
  }
  let archive = String(archiveName || '').trim() || (names.length === 1 ? names[0] : 'archive');
  if (!archive.toLowerCase().endsWith('.zip')) archive += '.zip';
  validateName(archive);
  const target = await uniqueTarget(dir.target, archive);
  try {
    // -y : les liens symboliques sont stockés tels quels, jamais suivis hors du dossier
    await execFileAsync('zip', ['-r', '-q', '-y', target, '--', ...names], { cwd: dir.target, timeout: 15 * 60 * 1000 });
  } catch (err) {
    await rm(target, { force: true });
    if (err.code === 'ENOENT' && String(err.syscall).startsWith('spawn')) {
      throw new HttpError(500, 'La commande zip est absente : sudo apt install zip');
    }
    throw new HttpError(500, `Compression impossible : ${(err.stderr || err.message).toString().trim()}`);
  }
  return path.basename(target);
}

// Extrait une archive dans un nouveau dossier portant son nom.
export async function extractArchive(root, rel) {
  const src = await resolveInside(root, rel, { mustExist: true });
  const name = path.basename(src.target);
  if (!ARCHIVE_RE.test(name)) throw new HttpError(400, 'Format non pris en charge (.zip, .tar, .tar.gz, .tgz)');
  const dest = await uniqueTarget(path.dirname(src.target), name.replace(ARCHIVE_RE, '') || 'archive');
  await mkdir(dest);
  const [command, args] = name.toLowerCase().endsWith('.zip')
    ? ['unzip', ['-q', '-o', src.target, '-d', dest]]
    : ['tar', ['-xf', src.target, '-C', dest, '--no-same-owner']];
  try {
    await execFileAsync(command, args, { timeout: 15 * 60 * 1000 });
  } catch (err) {
    await rm(dest, { recursive: true, force: true });
    throw new HttpError(500, `Extraction impossible : ${(err.stderr || err.message).toString().trim()}`);
  }
  return path.basename(dest);
}

// Lance `zip` en écrivant l'archive sur sa sortie standard (téléchargement d'un dossier ou d'une sélection).
export async function zipStream(root, dirRel, names) {
  const dir = await resolveInside(root, dirRel, { mustExist: true });
  validatePaths(names);
  for (const name of names) {
    validateName(name);
    await resolveInside(root, path.posix.join(dir.rel, name), { mustExist: true, noFollowLast: true });
  }
  const child = spawn('zip', ['-r', '-q', '-y', '-', '--', ...names], { cwd: dir.target, stdio: ['ignore', 'pipe', 'ignore'] });
  return { child, name: names.length === 1 ? `${names[0]}.zip` : `${path.basename(dir.target)}.zip` };
}
