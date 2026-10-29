import fs from 'node:fs';
import { createECDH, ECDH, createHash } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import webPush from 'web-push';

const TIMEOUT = 10_000;
const MAX_CONFIG_BYTES = 4096;

function failure(code, statusCode, safeRetryAfter) {
  const error = new Error(code);
  error.code = code;
  if (statusCode !== undefined) error.statusCode = statusCode;
  if (safeRetryAfter !== undefined) error.safeRetryAfter = safeRetryAfter;
  return error;
}

function decode(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw failure('PUSH_INVALID_KEY');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) throw failure('PUSH_INVALID_KEY');
  return bytes;
}

function publicPoint(value) {
  const bytes = decode(value, 65);
  if (bytes[0] !== 4) throw failure('PUSH_INVALID_KEY');
  try { ECDH.convertKey(bytes, 'prime256v1'); } catch { throw failure('PUSH_INVALID_KEY'); }
  return bytes;
}

function validSubject(subject) {
  if (typeof subject !== 'string' || subject.length > 1024 || /[\s\x00-\x1f\x7f]/.test(subject)) return false;
  try {
    const url = new URL(subject);
    if (url.protocol === 'mailto:') return /^[^@/?#]+@[^@/?#]+\.[^@/?#]+$/.test(url.pathname) && !url.search && !url.hash;
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

// /data/config/vapid.json 是容器内约定路径，不是宿主机路径。
export function loadPushConfiguration(env = process.env) {
  const enabled = env.PAGE_GATHER_PUSH_ENABLED === 'true';
  const result = { enabled, configured: false, publicKey: null, privateKey: null, subject: null, reason: 'PUSH_DISABLED' };
  if (!enabled) return result;
  if (!validSubject(env.PAGE_GATHER_VAPID_SUBJECT)) return { ...result, reason: 'PUSH_INVALID_SUBJECT' };
  let fd;
  try {
    const path = env.PAGE_GATHER_VAPID_FILE || '/data/config/vapid.json';
    const before = fs.lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > MAX_CONFIG_BYTES) {
      return { ...result, reason: 'PUSH_UNSAFE_KEY_FILE' };
    }
    fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_CONFIG_BYTES) {
      return { ...result, reason: 'PUSH_UNSAFE_KEY_FILE' };
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > MAX_CONFIG_BYTES) return { ...result, reason: 'PUSH_UNSAFE_KEY_FILE' };
    const keys = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (!keys || Object.keys(keys).sort().join(',') !== 'privateKey,publicKey') throw failure('PUSH_INVALID_KEY');
    const pub = publicPoint(keys.publicKey);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(decode(keys.privateKey, 32));
    if (!ecdh.getPublicKey().equals(pub)) throw failure('PUSH_INVALID_KEY');
    return { enabled, configured: true, publicKey: keys.publicKey, privateKey: keys.privateKey, subject: env.PAGE_GATHER_VAPID_SUBJECT, reason: null };
  } catch (error) {
    return { ...result, reason: error?.code === 'ENOENT' ? 'PUSH_KEY_FILE_MISSING' : 'PUSH_INVALID_CONFIGURATION' };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function supportedHost(host) {
  return host === 'fcm.googleapis.com' || ['.push.services.mozilla.com', '.push.apple.com'].some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

// 返回仅含标准字段的新对象；无效输入抛出不含原始值的固定错误码。
export function validatePushSubscription(input) {
  try {
    if (!input || typeof input !== 'object' || typeof input.endpoint !== 'string' || input.endpoint.length > 4096 || /[\s\x00-\x1f\x7f]/.test(input.endpoint)) throw 0;
    const url = new URL(input.endpoint);
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash || input.endpoint.includes('#') || !supportedHost(url.hostname)) throw 0;
    publicPoint(input.keys?.p256dh);
    decode(input.keys?.auth, 16);
    const expirationTime = input.expirationTime ?? null;
    if (expirationTime !== null && (typeof expirationTime !== 'number' || !Number.isFinite(expirationTime) || expirationTime < 0)) throw 0;
    return { endpoint: url.href, expirationTime, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
  } catch { throw failure('PUSH_INVALID_SUBSCRIPTION'); }
}

function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const p = address.split('.').map(Number);
    const [a, b, c] = p;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) !== 6 || address.includes('%')) return false;
  // 仅放行全球单播 2000::/3；排除文档、隧道及特殊用途范围，包括所有 IPv4 mapped 地址。
  const expanded = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const first = parseInt(expanded.split(':')[0], 16);
  if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff || first === 0x2002 || first >= 0x3ffe) return false;
  if (first === 0x2001) {
    const second = parseInt(expanded.split(':')[1] || '0', 16);
    if (second < 0x200 || second === 0xdb8) return false;
  }
  return true;
}

function retryAfter(headers) {
  const value = headers?.['retry-after'];
  if (typeof value !== 'string' || value.length > 128) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.min(3600, Math.max(0, Math.ceil(seconds))) : undefined;
}

function safeError(error) {
  if (['PUSH_ABORTED', 'PUSH_TIMEOUT', 'PUSH_DNS_BLOCKED', 'PUSH_DNS_FAILED'].includes(error?.code)) return failure(error.code);
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 100 && error.statusCode <= 599) {
    return failure('PUSH_HTTP_ERROR', error.statusCode, retryAfter(error.headers));
  }
  return failure('PUSH_NETWORK_ERROR');
}

export function createPushTransport(config, testDependencies = {}) {
  const sendNotification = testDependencies.webPushSend || ((...args) => webPush.sendNotification(...args));
  const lookup = testDependencies.lookup || dns.lookup;
  return async function send({ subscription, payload, notificationId, signal }) {
    if (!config?.enabled || !config.configured) throw failure('PUSH_NOT_CONFIGURED');
    const checked = validatePushSubscription(subscription);
    if (signal?.aborted) throw failure('PUSH_ABORTED');
    const hostname = new URL(checked.endpoint).hostname;
    let stopped = false;
    let stopError;
    const requests = new Set();
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1, lookup(host, options, callback) {
      if (stopped) return callback(stopError);
      if (host !== hostname || !supportedHost(host)) return callback(failure('PUSH_DNS_BLOCKED'));
      try {
        lookup(host, { all: true, verbatim: true }, (error, records) => {
          if (stopped) return callback(stopError);
          if (error || !Array.isArray(records) || !records.length) return callback(failure('PUSH_DNS_FAILED'));
          if (records.some((record) => !publicAddress(record.address) || net.isIP(record.address) !== record.family)) return callback(failure('PUSH_DNS_BLOCKED'));
          if (options?.all) callback(null, records);
          else callback(null, records[0].address, records[0].family);
        });
      } catch { callback(failure('PUSH_DNS_FAILED')); }
    } });
    const addRequest = agent.addRequest.bind(agent);
    agent.addRequest = (request, options) => {
      if (stopped) { request.destroy(stopError); return; }
      requests.add(request);
      request.once('close', () => requests.delete(request));
      addRequest(request, options);
    };
    function stop(error) {
      if (stopped) return;
      stopped = true;
      stopError = error;
      for (const request of requests) request.destroy(error);
      agent.destroy();
    }
    let timer;
    let abort;
    try {
      return await new Promise((resolve, reject) => {
        const cancel = (code) => { const error = failure(code); stop(error); reject(error); };
        abort = () => cancel('PUSH_ABORTED');
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => cancel('PUSH_TIMEOUT'), TIMEOUT);
        if (signal?.aborted) { abort(); return; }
        Promise.resolve().then(() => {
          if (stopped) throw stopError;
          return sendNotification(checked, typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload), {
            agent, timeout: TIMEOUT, TTL: 3600, contentEncoding: 'aes128gcm',
            topic: createHash('sha256').update(String(notificationId)).digest('base64url').slice(0, 32),
            vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey }
          });
        }).then((response) => {
          const statusCode = response?.statusCode;
          if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode > 299) throw { statusCode, headers: response?.headers };
          const retry = retryAfter(response.headers);
          resolve({ statusCode, headers: retry === undefined ? {} : { 'retry-after': String(retry) } });
        }).catch((error) => reject(safeError(error)));
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      stop(failure('PUSH_ABORTED'));
    }
  };
}
