import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Versions d'AstraPanel et noms des branches où elles sont publiées.
//
// - « AstraPanel-Latest » contient toujours la dernière version : les panels installés la surveillent
//   et lisent sa version dans package.json.
// - Chaque version est aussi conservée sur sa propre branche « AstraPanel-V.X.Y.Z ».

export const LATEST_BRANCH = 'AstraPanel-Latest';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_BRANCH_RE = /^AstraPanel-V\.(\d+\.\d+\.\d+)$/;

export function parseVersion(version) {
  const m = VERSION_RE.exec(String(version ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// < 0 si a est plus ancienne que b, > 0 si plus récente, 0 si égales (ou illisibles).
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// Version suivante, en ajoutant 0.0.1 avec retenue : 1.2.8 → 1.2.9 → 1.3.0, et 1.9.9 → 2.0.0.
export function nextVersion(version) {
  const v = parseVersion(version);
  if (!v) throw new Error(`Version invalide : « ${version} » (attendu : X.Y.Z)`);
  let [major, minor, patch] = v;
  patch += 1;
  if (patch > 9) {
    patch = 0;
    minor += 1;
  }
  if (minor > 9) {
    minor = 0;
    major += 1;
  }
  return `${major}.${minor}.${patch}`;
}

export const versionBranch = (version) => `AstraPanel-V.${version}`;

export function parseVersionBranch(name) {
  const m = VERSION_BRANCH_RE.exec(String(name));
  return m ? m[1] : null;
}

// Utilisé par scripts/nouvelle-version.sh : node src/version.js next 1.2.9 → 1.3.0
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'next') console.log(nextVersion(arg));
  else if (cmd === 'compare') console.log(Math.sign(compareVersions(arg, process.argv[4])));
  else {
    console.error('Usage : node src/version.js next X.Y.Z | compare A B');
    process.exit(1);
  }
}
