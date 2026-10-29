import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { HttpError, isHttps, parseCookies } from './http/util.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'astra_session';
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [algo, saltB64, hashB64] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function validateCredentials(username, password) {
  if (!USERNAME_RE.test(String(username || ''))) {
    throw new HttpError(400, "Nom d'utilisateur invalide (3 à 32 caractères : lettres, chiffres, . _ -)");
  }
  validatePassword(password);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Le mot de passe doit contenir au moins 8 caractères');
  }
  if (password.length > 256) throw new HttpError(400, 'Mot de passe trop long');
}

export class Auth {
  constructor(store, dataDir) {
    this.store = store;
    this.setupTokenFile = path.join(dataDir, 'setup-token');
    this.secret = this.loadSecret(path.join(dataDir, 'secret.key'));
    this.attempts = new Map();
    this.dummyHash = null;
  }

  loadSecret(file) {
    if (existsSync(file)) return readFileSync(file);
    const secret = crypto.randomBytes(64);
    writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }

  get setupRequired() {
    return this.store.data.users.length === 0;
  }

  // Jeton à usage unique pour créer le premier compte (affiché dans les logs et écrit dans data/setup-token).
  ensureSetupToken() {
    if (!this.setupRequired) {
      if (existsSync(this.setupTokenFile)) unlinkSync(this.setupTokenFile);
      return null;
    }
    let token;
    if (existsSync(this.setupTokenFile)) {
      token = readFileSync(this.setupTokenFile, 'utf8').trim();
    } else {
      token = crypto.randomBytes(9).toString('base64url');
      writeFileSync(this.setupTokenFile, token + '\n', { mode: 0o600 });
    }
    return token;
  }

  checkSetupToken(token) {
    const expected = this.ensureSetupToken();
    if (!expected || typeof token !== 'string') return false;
    const a = Buffer.from(token.trim());
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  findUser(username) {
    return this.store.data.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
  }

  async createUser(username, password) {
    validateCredentials(username, password);
    if (this.findUser(username)) throw new HttpError(409, "Ce nom d'utilisateur existe déjà");
    const user = {
      id: crypto.randomUUID(),
      username,
      hash: await hashPassword(password),
      tokenVersion: 1,
      createdAt: Date.now(),
    };
    this.store.data.users.push(user);
    this.store.save();
    if (this.store.data.users.length === 1) this.ensureSetupToken();
    return user;
  }

  async login(username, password) {
    const user = this.findUser(username || '');
    if (!user) {
      // même coût de calcul qu'un vrai compte, pour ne pas révéler les noms existants
      this.dummyHash ??= await hashPassword('dummy-password');
      await verifyPassword(String(password || ''), this.dummyHash);
      return null;
    }
    return (await verifyPassword(String(password || ''), user.hash)) ? user : null;
  }

  async changePassword(user, current, next) {
    if (!(await verifyPassword(String(current || ''), user.hash))) {
      throw new HttpError(400, 'Mot de passe actuel incorrect');
    }
    validatePassword(next);
    user.hash = await hashPassword(next);
    user.tokenVersion += 1;
    this.store.save();
  }

  sign(payload) {
    return b64url(crypto.createHmac('sha256', this.secret).update(payload).digest());
  }

  createToken(user) {
    const payload = b64url(JSON.stringify({ u: user.id, v: user.tokenVersion, e: Date.now() + SESSION_TTL }));
    return `${payload}.${this.sign(payload)}`;
  }

  verifyToken(token) {
    if (typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!data || data.e < Date.now()) return null;
    const user = this.store.data.users.find((u) => u.id === data.u);
    if (!user || user.tokenVersion !== data.v) return null;
    return user;
  }

  userFromRequest(req) {
    return this.verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
  }

  setSessionCookie(req, res, user) {
    const parts = [
      `${COOKIE}=${this.createToken(user)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${SESSION_TTL / 1000}`,
    ];
    if (isHttps(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }

  // 10 tentatives de connexion par IP toutes les 15 minutes
  checkRateLimit(ip) {
    const now = Date.now();
    let entry = this.attempts.get(ip);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + 15 * 60 * 1000 };
      this.attempts.set(ip, entry);
    }
    if (entry.count >= 10) {
      const minutes = Math.ceil((entry.reset - now) / 60000);
      throw new HttpError(429, `Trop de tentatives. Réessayez dans ${minutes} min.`);
    }
    entry.count += 1;
    if (this.attempts.size > 5000) {
      for (const [key, val] of this.attempts) if (val.reset < now) this.attempts.delete(key);
    }
  }

  resetRateLimit(ip) {
    this.attempts.delete(ip);
  }
}

export function publicUser(user) {
  return user ? { id: user.id, username: user.username, createdAt: user.createdAt } : null;
}
