import { spawn } from 'node:child_process';
import { lineSplitter } from './logs.js';

const BASE_ENV_KEYS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'USER', 'LOGNAME', 'SHELL',
  // réseau : proxy et certificats éventuels, nécessaires à npm et git derrière un proxy
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO',
];

// Environnement minimal transmis aux applis : on ne fait pas fuiter celui du panel.
export function baseEnv() {
  const env = {};
  for (const key of BASE_ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
  env.PATH ||= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return env;
}

export function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

// Branche stdout/stderr d'un processus sur le journal de l'app.
export function pipeOutput(child, log) {
  for (const [stream, name] of [[child.stdout, 'out'], [child.stderr, 'err']]) {
    if (!stream) continue;
    stream.setEncoding('utf8');
    const splitter = lineSplitter((line) => log.push(name, line));
    stream.on('data', (chunk) => splitter.write(chunk));
    stream.on('end', () => splitter.end());
  }
}

/**
 * Lance une commande ponctuelle (git, npm install, build…) dans son propre groupe de processus,
 * avec la sortie dans le journal. Rejette si le code de sortie n'est pas 0.
 */
export function runCommand(command, args, { cwd, env, log, label, timeout = 20 * 60 * 1000, onSpawn }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`${label} : ${err.message}`));
      return;
    }
    onSpawn?.(child);
    pipeOutput(child, log);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGKILL');
    }, timeout);
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    child.on('error', (err) => finish(new Error(`${label} : ${err.message}`)));
    child.on('exit', (code, signal) => {
      killGroup(child.pid, 'SIGKILL'); // nettoie d'éventuels processus restants du groupe
      if (timedOut) finish(new Error(`${label} : délai dépassé`));
      else if (code === 0) finish();
      else if (signal) finish(new Error(`${label} interrompu (${signal})`));
      else finish(new Error(`${label} a échoué (code ${code})`));
    });
  });
}

export function runShell(commandLine, options) {
  return runCommand('/bin/sh', ['-c', commandLine], options);
}
