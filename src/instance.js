import { linkSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_FILE = fileURLToPath(new URL('./server.js', import.meta.url));

// Garde-fous du démarrage : un seul panel à la fois, et jamais un panel lancé par une de ses applications.
// Sans eux, une application lancée avec « npm start » dans un dossier sans package.json fait remonter npm jusqu'au
// package.json du panel : un second panel démarre alors sur les mêmes données, relance les applications (donc de
// nouveau « npm start »)… et les panels se multiplient jusqu'au plantage.

// Messages repérés par le gestionnaire d'applications dans la console d'une appli (voir AppManager.handleExit)
export const REFUSED_FROM_APP = 'AstraPanel refuse de démarrer depuis une application du panel';
export const REFUSED_ALREADY_RUNNING = 'AstraPanel tourne déjà avec ces données';

// Toutes les applications reçoivent ASTRA_APP_ID : sa présence signifie que ce panel a été lancé par une appli.
export function launchedByApp(env = process.env) {
  if (!env.ASTRA_APP_ID) return null;
  return (
    `✖ ${REFUSED_FROM_APP} (« ${env.ASTRA_APP_NAME || env.ASTRA_APP_ID} »). ` +
    'Sa commande de démarrage lance AstraPanel lui-même (souvent « npm start » dans un dossier sans package.json : ' +
    'npm prend alors celui du panel). Ajoutez le code de l’application ou changez sa commande de démarrage.'
  );
}

// Le processus `pid` est-il encore un panel en marche ?
function panelAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false; // processus disparu
  }
  let args;
  let cwd;
  try {
    args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return true; // pas de /proc lisible : dans le doute, on le considère en marche
  }
  // un numéro de processus peut être réutilisé : on vérifie que c'est bien ce panel (son fichier src/server.js), et
  // pas, par exemple, le « node server.js » d'un site hébergé
  return args.some((arg) => arg.endsWith('server.js') && path.resolve(cwd, arg) === SERVER_FILE);
}

/**
 * Verrou du dossier de données (fichier panel.pid) : un seul panel par dossier de données. Un verrou laissé par un
 * panel arrêté brutalement est repris. Renvoie { ok: true, release } ou { ok: false, pid } si un panel tourne déjà.
 */
export function acquireInstanceLock(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'panel.pid');
  const readPid = () => {
    try {
      return Number(readFileSync(file, 'utf8').trim()) || null;
    } catch {
      return null;
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    // le fichier apparaît d'un coup, numéro de processus compris (lien vers un fichier temporaire)
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, String(process.pid));
    try {
      linkSync(tmp, file);
      const release = () => {
        if (readPid() === process.pid) rmSync(file, { force: true });
      };
      process.on('exit', release);
      return { ok: true, file, release };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    } finally {
      rmSync(tmp, { force: true });
    }
    const pid = readPid();
    if (panelAlive(pid)) return { ok: false, pid };
    // verrou périmé (panel arrêté brutalement) : retiré s'il n'a pas changé entre-temps
    if (readPid() === pid) rmSync(file, { force: true });
  }
  return { ok: false, pid: readPid() };
}
