import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Auth, configuration } from './auth.js';
import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { Dispatcher } from './dispatcher.js';
import { createPushTransport, loadPushConfiguration } from './push-transport.js';
import { plugins } from './registry.js';
import { ApiError, check, object } from './errors.js';

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
async function body(req, optional = false) {
  if (optional && !req.headers['transfer-encoding'] && Number(req.headers['content-length'] ?? 0) === 0) return {};
  check((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json', 'JSON_REQUIRED', 415);
  check(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'CONTENT_ENCODING_UNSUPPORTED', 415);
  const length = Number(req.headers['content-length'] ?? 0); check(Number.isFinite(length) && length <= MAX_BODY_BYTES, 'REQUEST_TOO_LARGE', 413);
  const buffers = await new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const cleanup = () => { req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('aborted', onAbort); req.removeListener('error', onError); };
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { cleanup(); req.resume(); reject(new ApiError('REQUEST_TOO_LARGE',413)); }
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(chunks); };
    const onAbort = () => { cleanup(); reject(new ApiError('REQUEST_ABORTED',400)); };
    const onError = () => { cleanup(); reject(new ApiError('REQUEST_READ_FAILED',400)); };
    req.on('data',onData); req.once('end',onEnd); req.once('aborted',onAbort); req.once('error',onError);
  });
  let parsed; try { parsed = JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw new ApiError('INVALID_JSON',400); }
  check(object(parsed), 'INVALID_JSON',400); return parsed;
}
const pagination = url => ({ limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50, cursor: url.searchParams.get('cursor'), q: url.searchParams.get('q') ?? '', type: url.searchParams.get('type') ?? '' });
export function createServer({ store, auth, schedulerOptions, dispatcherOptions, pushConfig, pushTransport, env = process.env, ...options } = {}) {
  const ownedStore = !store;
  pushConfig ??= store?.notifications.config ?? loadPushConfiguration(env);
  auth ??= new Auth(options); store ??= new Store({ ...options, pushConfig });
  const notifications = store.notifications; notifications.configure(pushConfig);
  const scheduler = new Scheduler(store, schedulerOptions);
  const dispatcher = new Dispatcher(notifications, pushTransport ?? createPushTransport(pushConfig), dispatcherOptions);
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const send = (status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-request-id': requestId, ...headers }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://internal'); const path = url.pathname; const method = req.method;
      check(path.startsWith('/api/v1/'), 'NOT_FOUND',404);
      if (path === '/api/v1/health' && method === 'GET') {
        const { enabled, healthy } = scheduler.status();
        return send(healthy ? 200 : 503, { status: healthy ? 'ok' : 'degraded', scheduler: { enabled, healthy } });
      }
      if (path.startsWith('/api/v1/worker/')) {
        auth.worker(req); check(method === 'POST', 'METHOD_NOT_ALLOWED',405);
        const input = await body(req);
        if (path === '/api/v1/worker/status') return send(200, { worker: store.workerStatus(input) });
        if (path === '/api/v1/worker/claims') { const result = store.claim(input); return send(result ? 200 : 204, result); }
        const match = path.match(/^\/api\/v1\/worker\/runs\/([A-Za-z0-9_-]+)\/(collections|heartbeat|submissions|outcome|recover|recover-finalization)(?:\/([A-Za-z0-9_-]+)\/seal)?$/);
        check(match, 'NOT_FOUND',404);
        const [, id, action, collectionId] = match;
        if (collectionId) { check(action === 'collections', 'NOT_FOUND',404); return send(200,store.seal(id,collectionId,input)); }
        const actions = { collections: 'register', heartbeat: 'heartbeat', submissions: 'submit', outcome: 'outcome', recover: 'recover', 'recover-finalization':'recoverFinalization' };
        return send(200, store[actions[action]](id,input));
      }
      if (method !== 'GET' && method !== 'HEAD') auth.origin(req);
      if (path === '/api/v1/auth/login' && method === 'POST') {
        const cookie = auth.login(req,await body(req)); return send(200, { user: { username: 'admin' } }, { 'set-cookie': cookie });
      }
      const sessionId = auth.session(req);
      if (path === '/api/v1/scheduler' && method === 'GET') return send(200, scheduler.status());
      if (path === '/api/v1/auth/me' && method === 'GET') return send(200,{ user: { username: 'admin' } });
      if (path === '/api/v1/auth/logout' && method === 'POST') {
        const input = await body(req, true);
        check(Object.keys(input).every(k => k === 'subscriptionId'), 'INVALID_LOGOUT', 400);
        if (input.subscriptionId !== undefined) notifications.removeDevice(input.subscriptionId, sessionId);
        return send(200,{ ok:true }, { 'set-cookie':auth.logout(req) });
      }
      if (path === '/api/v1/notification-rules') {
        if (method === 'GET') return send(200, notifications.rules());
        if (method === 'POST') return send(201, { rule: notifications.createRule(await body(req)) });
      }
      const ruleMatch = path.match(/^\/api\/v1\/notification-rules\/([A-Za-z0-9_-]+)$/);
      if (ruleMatch) {
        if (method === 'PATCH') return send(200, { rule: notifications.patchRule(ruleMatch[1], await body(req)) });
        if (method === 'DELETE') { notifications.deleteRule(ruleMatch[1]); return send(200, { ok: true }); }
      }
      if (path === '/api/v1/notifications' && method === 'GET') return send(200, notifications.list({ ...pagination(url), unread: url.searchParams.get('unread') }));
      if (path === '/api/v1/notifications/unread-count' && method === 'GET') return send(200, notifications.unreadCount());
      if (path === '/api/v1/notifications/read-all' && method === 'POST') {
        const input = await body(req, true); check(!Object.keys(input).length, 'INVALID_READ', 400); return send(200, notifications.readAll());
      }
      const notificationMatch = path.match(/^\/api\/v1\/notifications\/([A-Za-z0-9_-]+)$/);
      if (notificationMatch) {
        if (method === 'GET') return send(200, { notification: notifications.view(notifications.notification(notificationMatch[1])) });
        if (method === 'PATCH') return send(200, { notification: notifications.read(notificationMatch[1], await body(req)) });
      }
      if (path === '/api/v1/push/config' && method === 'GET') return send(200, notifications.configView());
      if (path === '/api/v1/push/status' && method === 'GET') return send(200, dispatcher.status());
      if (path === '/api/v1/push/subscriptions') {
        if (method === 'GET') return send(200, notifications.devices(sessionId));
        if (method === 'POST') return send(201, { subscription: notifications.registerDevice(await body(req), sessionId) });
      }
      const deviceMatch = path.match(/^\/api\/v1\/push\/subscriptions\/([A-Za-z0-9_-]+)$/);
      if (deviceMatch && method === 'DELETE') { notifications.removeDevice(deviceMatch[1], sessionId); return send(200, { ok: true }); }
      if (path === '/api/v1/push/test' && method === 'POST') return send(202, { notification: notifications.testPush(req.headers['idempotency-key'], await body(req), sessionId) });
      if (path === '/api/v1/plugins' && method === 'GET') return send(200,{ items: plugins, nextCursor:null });
      if (path === '/api/v1/tasks') {
        if (method === 'GET') return send(200,store.list('tasks',pagination(url)));
        if (method === 'POST') return send(201,{ task:store.createTask(await body(req)) });
      }
      if (['runs','entities','workers'].some(name => path === `/api/v1/${name}`) && method === 'GET') {
        return send(200,store.list(path.split('/').at(-1),pagination(url)));
      }
      const match = path.match(/^\/api\/v1\/(tasks|runs|entities)\/([A-Za-z0-9_-]+)(?:\/(runs|cancel|versions))?$/);
      if (match) {
        const [, resource,id,action] = match;
        if (resource === 'tasks' && !action) {
          if (method === 'GET') return send(200,{ task:store.getTask(id) });
          if (method === 'PATCH') return send(200,{ task:store.patchTask(id,await body(req)) });
        }
        if (resource === 'tasks' && action === 'runs' && method === 'POST') { const input = await body(req,true); return send(202,{ run:store.createRun(id,req.headers['idempotency-key'],input) }); }
        if (resource === 'runs' && !action && method === 'GET') return send(200,{ run:store.getRun(id) });
        if (resource === 'runs' && action === 'cancel' && method === 'POST') { await body(req,true); return send(200,store.cancel(id)); }
        if (resource === 'entities' && (!action || action === 'versions') && method === 'GET') {
          const result = store.getEntity(id,pagination(url)); return send(200,action ? { items:result.versions,nextCursor:result.nextCursor } : result);
        }
      }
      if (path.startsWith('/api/v1/artifacts')) throw new ApiError('ARTIFACT_UPLOAD_NOT_IMPLEMENTED',501);
      throw new ApiError('NOT_FOUND',404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const known = error instanceof ApiError;
      send(known ? error.status : 500, { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.code : 'INTERNAL_ERROR' }, requestId });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 100;
  server.scheduler = scheduler; server.dispatcher = dispatcher;
  const close = server.close.bind(server); let storeClosed = false;
  server.close = callback => {
    scheduler.stop(); const stopped = dispatcher.stop();
    return close(error => {
      void stopped.then(() => {
        if (ownedStore && !storeClosed) { storeClosed = true; store.close(); }
        callback?.(error);
      });
    });
  };
  scheduler.start(); dispatcher.start();
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = configuration();
    const server = createServer(config);
    server.on('error', () => { console.error('SERVER_LISTEN_FAILED'); process.exitCode = 1; server.close(); });
    server.listen(config.port,config.host, () => console.info('SERVER_READY'));
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal,() => server.close());
  } catch { console.error('SERVER_START_FAILED'); process.exitCode = 1; }
}
