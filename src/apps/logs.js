import { closeSync, createWriteStream, existsSync, openSync, readSync, renameSync, statSync, truncateSync } from 'node:fs';

// Séquences d'échappement des terminaux : CSI (\x1b[…), OSC (\x1b]…), séquences courtes et ESC isolé
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]|\x1b/g;
// Couleurs et styles du texte (SGR : \x1b[…m), les seules gardées dans les journaux
const SGR_RE = /^\x1b\[[0-9;:]*m$/;
// caractères de contrôle invisibles (sauf tabulation et ESC des couleurs)
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;
const LINE_RE = /^(\S+) \[(out|err|sys)\] (.*)$/;
const MAX_LINE = 4000;

export function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

// Garde les couleurs choisies par l'application (affichées par la console du panel) et retire le reste
// (déplacements du curseur, effacements de ligne, titres de fenêtre, liens…).
export function keepColors(text) {
  return text.replace(ANSI_RE, (seq) => (SGR_RE.test(seq) ? seq : '')).replace(CONTROL_RE, '');
}

// Découpe un flux texte en lignes complètes.
export function lineSplitter(onLine) {
  let buf = '';
  return {
    write(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      if (buf.length > 16384) {
        onLine(buf);
        buf = '';
      }
    },
    end() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

/**
 * Journal d'une application : les dernières lignes en mémoire (pour la console en direct)
 * et un fichier sur disque avec rotation simple (app.log -> app.log.1).
 */
export class LogBuffer {
  constructor(file, { maxLines = 1000, maxFileBytes = 5 * 1024 * 1024 } = {}) {
    this.file = file;
    this.maxLines = maxLines;
    this.maxFileBytes = maxFileBytes;
    this.lines = [];
    this.subscribers = new Set();
    this.size = existsSync(file) ? statSync(file).size : 0;
    this.loadTail();
    this.stream = createWriteStream(file, { flags: 'a' });
  }

  loadTail() {
    if (!this.size) return;
    const length = Math.min(this.size, 256 * 1024);
    const buf = Buffer.alloc(length);
    const fd = openSync(this.file, 'r');
    try {
      readSync(fd, buf, 0, length, this.size - length);
    } finally {
      closeSync(fd);
    }
    const rows = buf.toString('utf8').split('\n');
    if (length < this.size) rows.shift(); // première ligne probablement tronquée
    for (const row of rows) {
      const m = LINE_RE.exec(row);
      if (!m) continue;
      const t = Date.parse(m[1]);
      this.lines.push({ t: Number.isNaN(t) ? 0 : t, s: m[2], m: m[3] });
    }
    if (this.lines.length > this.maxLines) this.lines = this.lines.slice(-this.maxLines);
  }

  push(stream, message) {
    let text = keepColors(String(message).replace(/\r/g, ''));
    // ligne trop longue : coupée, sans laisser une séquence de couleur à moitié
    if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE).replace(/\x1b[^m]*$/, '') + '\x1b[0m…';
    const line = { t: Date.now(), s: stream, m: text };
    this.lines.push(line);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    this.writeToFile(line);
    for (const fn of this.subscribers) fn(line);
    return line;
  }

  system(message) {
    return this.push('sys', message);
  }

  writeToFile(line) {
    if (!this.stream) return;
    const row = `${new Date(line.t).toISOString()} [${line.s}] ${line.m.replace(/\n/g, ' ')}\n`;
    this.size += Buffer.byteLength(row);
    this.stream.write(row);
    if (this.size > this.maxFileBytes) this.rotate();
  }

  rotate() {
    this.stream.end();
    try {
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // ignore
    }
    this.size = 0;
    this.stream = createWriteStream(this.file, { flags: 'a' });
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  clear() {
    this.lines = [];
    this.stream.end();
    try {
      truncateSync(this.file, 0);
    } catch {
      // ignore
    }
    this.size = 0;
    this.stream = createWriteStream(this.file, { flags: 'a' });
    for (const fn of this.subscribers) fn({ clear: true });
  }

  close() {
    this.subscribers.clear();
    this.stream?.end();
    this.stream = null;
  }
}
