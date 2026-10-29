import { readFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { ApiError, check } from './errors.js';
import { loadPushConfiguration } from './push-transport.js';

const equal = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y); };
function secretFile(filename) {
  check(typeof filename === 'string' && filename.length > 0, 'SECRET_FILE_REQUIRED', 500);
  try { const fileValue = readFileSync(filename, 'utf8').trimEnd(); check(fileValue.length > 0 && fileValue.length <= 4096, 'SECRET_FILE_INVALID', 500); return fileValue; }
  catch { throw new ApiError('SECRET_FILE_UNREADABLE', 500); }
}
export function configuration(env = process.env) {
  let origin;
  try { const url = new URL(env.PAGE_GATHER_PUBLIC_ORIGIN); check(url.origin === env.PAGE_GATHER_PUBLIC_ORIGIN && ['http:','https:'].includes(url.protocol) && !url.username && !url.password, 'INVALID_PUBLIC_ORIGIN', 500); origin = url; }
  catch { throw new ApiError('PUBLIC_ORIGIN_REQUIRED', 500); }
  const secure = env.PAGE_GATHER_COOKIE_SECURE === undefined ? origin.protocol === 'https:' : env.PAGE_GATHER_COOKIE_SECURE === 'true';
  check(env.PAGE_GATHER_COOKIE_SECURE === undefined || ['true','false'].includes(env.PAGE_GATHER_COOKIE_SECURE), 'INVALID_COOKIE_SECURE', 500);
  check(env.NODE_ENV !== 'production' || origin.protocol === 'https:' && secure, 'PRODUCTION_HTTPS_REQUIRED', 500);
  check(origin.protocol !== 'https:' || secure, 'SECURE_COOKIE_REQUIRED', 500);
  check(origin.protocol !== 'http:' || ['localhost','127.0.0.1','[::1]'].includes(origin.hostname) && env.NODE_ENV !== 'production', 'DEVELOPMENT_LOOPBACK_REQUIRED', 500);
  const adminValue = secretFile(env.PAGE_GATHER_ADMIN_PASSWORD_FILE);
  const workerValue = secretFile(env.PAGE_GATHER_WORKER_TOKEN_FILE);
  return { publicOrigin: origin.origin, secureCookie: secure, pushConfig: loadPushConfiguration(env),
    password: adminValue, workerToken: workerValue,
    workerId: env.PAGE_GATHER_WORKER_ID ?? 'worker-main', filename: env.PAGE_GATHER_DATABASE_FILE ?? '/data/database/page-gather.sqlite',
    host: env.PAGE_GATHER_HOST ?? '0.0.0.0', port: Number(env.PAGE_GATHER_PORT ?? 3000) };
}
export class Auth {
  constructor({ password, workerToken, publicOrigin, secureCookie = true, now = Date.now }) {
    check(password && workerToken && password !== workerToken, 'DISTINCT_SECRETS_REQUIRED', 500);
    this.salt = randomBytes(32); this.passwordHash = scryptSync(password, this.salt, 64); this.sessionKey = randomBytes(32);
    this.workerToken = workerToken; this.publicOrigin = publicOrigin; this.secureCookie = secureCookie; this.now = now;
    this.sessions = new Map(); this.attempts = new Map();
  }
  origin(req) { check(req.headers.origin === this.publicOrigin, 'ORIGIN_REJECTED', 403); }
  worker(req) { check(typeof req.headers.authorization === 'string' && equal(req.headers.authorization, `Bearer ${this.workerToken}`), 'WORKER_UNAUTHORIZED', 401); }
  session(req) {
    const value = (req.headers.cookie ?? '').split(';').map(p => p.trim()).find(p => p.startsWith('pg_session='))?.slice(11);
    check(value && value.length < 200, 'UNAUTHORIZED', 401);
    const [id, signature, extra] = value.split('.');
    check(!extra && id && signature && equal(signature, this.sign(id)), 'UNAUTHORIZED', 401);
    check((this.sessions.get(id) ?? 0) > this.now(), 'UNAUTHORIZED', 401); return id;
  }
  sign(id) { return createHmac('sha256', this.sessionKey).update(id).digest('base64url'); }
  cookie(value, maxAge) { return `pg_session=${value}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secureCookie ? '; Secure' : ''}`; }
  login(req, body) {
    const address = req.socket.remoteAddress ?? 'unknown';
    const now = this.now();
    for (const [ip, attempt] of this.attempts) if (attempt.until <= now) this.attempts.delete(ip);
    const attempt = this.attempts.get(address) ?? { count: 0, until: now + 60000 };
    check(attempt.count < 5 && this.attempts.size < 10000, 'LOGIN_RATE_LIMITED', 429);
    attempt.count++; this.attempts.set(address, attempt);
    const password = typeof body.password === 'string' && body.password.length <= 4096 ? body.password : '';
    const computed = scryptSync(password, this.salt, 64);
    check(body.username === 'admin' && timingSafeEqual(this.passwordHash, computed), 'INVALID_CREDENTIALS', 401);
    this.attempts.delete(address);
    for (const [id, expires] of this.sessions) if (expires <= now) this.sessions.delete(id);
    if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value);
    const id = randomBytes(32).toString('base64url'); this.sessions.set(id, now + 12 * 3600000);
    return this.cookie(`${id}.${this.sign(id)}`, 12 * 3600);
  }
  logout(req) { this.sessions.delete(this.session(req)); return this.cookie('',0); }
}
