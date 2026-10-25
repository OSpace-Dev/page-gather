import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { join, resolve, parse } from 'node:path';

export function fail(code) { return Object.assign(new Error(code), { code }); }
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw fail('INVALID_JSON');
  return result;
}
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export const DEFAULT_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;
function byteBudget(store, requested) {
  const value = requested ?? store?.maxBytes ?? DEFAULT_CHECKPOINT_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) throw fail('INVALID_CHECKPOINT_MAX_BYTES');
  if (store?.maxBytes !== undefined && store.maxBytes !== value) throw fail('CHECKPOINT_MAX_BYTES_MISMATCH');
  return value;
}
const id = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw fail('INVALID_STORAGE_KEY'); return value; };

// root 仅由受信宿主配置，不属于插件/任务用户参数；仅支持单写者租约。
export class JsonCheckpointStore {
  constructor({ root = '/data/spool', maxBytes = DEFAULT_CHECKPOINT_MAX_BYTES, beforeRename = async () => {} } = {}) {
    byteBudget(null, maxBytes);
    this.root = resolve(root); this.maxBytes = maxBytes; this.beforeRename = beforeRename;
  }
  async directory(runId) {
    const target = join(this.root, id(runId));
    const base = parse(target).root;
    const parts = target.slice(base.length).split(/[\\/]+/).filter(Boolean);
    let dir = base;
    for (const part of parts) {
      dir = join(dir, part);
      await mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('UNSAFE_STORAGE_PATH');
    }
    return dir;
  }
  async load(runId, collectionId) {
    try {
      const path = join(await this.directory(runId), `${id(collectionId)}.json`);
      if ((await lstat(path)).isSymbolicLink()) throw fail('UNSAFE_STORAGE_PATH');
      const handle = await open(path, 'r');
      try {
        if ((await handle.stat()).size > this.maxBytes) throw fail('CHECKPOINT_TOO_LARGE');
        return JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw fail(error.code === 'CHECKPOINT_TOO_LARGE' ? error.code : 'CHECKPOINT_READ_FAILED'); }
  }
  async save(runId, collectionId, document) {
    const text = canonical(document);
    if (Buffer.byteLength(text) > this.maxBytes) throw fail('CHECKPOINT_TOO_LARGE');
    const dir = await this.directory(runId);
    const temporary = join(dir, `${id(collectionId)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await this.beforeRename();
      await rename(temporary, join(dir, `${id(collectionId)}.json`));
    } catch { throw fail('CHECKPOINT_WRITE_FAILED'); }
    finally { await unlink(temporary).catch(() => {}); }
  }
}
export class MemoryCheckpointStore {
  documents = new Map();
  async load(runId, collectionId) { return structuredClone(this.documents.get(`${id(runId)}/${id(collectionId)}`) ?? null); }
  async save(runId, collectionId, document) { this.documents.set(`${id(runId)}/${id(collectionId)}`, structuredClone(document)); }
}

// 绑定 schema/version/config/collection，散列用于检测损坏，不充当防篡改签名。
export function checkpoint({ store, binding, validateState, maxBytes, payloadForState }) {
  maxBytes = byteBudget(store, maxBytes);
  let current = null; let phase = 'OPEN'; let submission = null; let initialDeadline = null; let exists = false;
  const sealedDocument = (payload, stateHash, deadline, submissionId = '00000000-0000-0000-0000-000000000000') => ({
    schemaVersion: 3, phase: 'SEALED', binding, initialDeadline: deadline, stateHash,
    submission: { submissionId, collectionId: binding.collectionId, collectionSeq: binding.collectionSeq, payloadHash: hash(payload), payload }
  });
  const sizeCheck = document => {
    if (Buffer.byteLength(canonical(document)) > maxBytes) throw fail('CHECKPOINT_TOO_LARGE');
  };
  const check = document => {
    sizeCheck(document);
    if (document?.schemaVersion !== 3 || !['OPEN', 'SEALED'].includes(document.phase) || hash(document.binding) !== hash(binding)) throw fail('CHECKPOINT_BINDING_MISMATCH');
    if ((document.initialDeadline != null && !Number.isFinite(document.initialDeadline)) || !/^[a-f0-9]{64}$/.test(document.stateHash)) throw fail('CHECKPOINT_INVALID');
    if (document.phase === 'SEALED') {
      if (Object.hasOwn(document, 'state') || !document.submission || typeof document.submission.submissionId !== 'string' || document.submission.payloadHash !== hash(document.submission.payload) || document.submission.collectionId !== binding.collectionId || document.submission.collectionSeq !== binding.collectionSeq) throw fail('CHECKPOINT_INVALID');
      return null; // SEALED 只提供 submission，不再提供可续采 state。
    }
    if (hash(document.state) !== document.stateHash || (document.state !== null && !validateState(document.state)) || Object.hasOwn(document, 'submission')) throw fail('CHECKPOINT_INVALID');
    // 接纳 OPEN 前预留完整封存包的预算，UUID/hash 长度固定。
    if (document.state !== null && payloadForState) sizeCheck(sealedDocument(payloadForState(document.state), document.stateHash, document.initialDeadline));
    return structuredClone(document.state);
  };
  return {
    get exists() { return exists; },
    get initialDeadline() { return initialDeadline; },
    get state() { return structuredClone(current); },
    get phase() { return phase; },
    get submission() { return structuredClone(submission); },
    async load() {
      const document = await store.load(binding.runId, binding.collectionId);
      current = document === null ? null : check(document);
      phase = document?.phase ?? 'OPEN'; submission = document?.submission ?? null;
      initialDeadline = document?.initialDeadline ?? null; exists = document !== null;
      return this.state;
    },
    async start(deadline) {
      if (initialDeadline !== null) return initialDeadline;
      if (phase === 'SEALED') throw fail('COLLECTION_SEALED');
      if (!Number.isFinite(deadline)) throw fail('INVALID_DEADLINE');
      const document = { schemaVersion: 3, phase, binding, initialDeadline: deadline, state: current, stateHash: hash(current) };
      check(document);
      await store.save(binding.runId, binding.collectionId, document);
      initialDeadline = deadline; exists = true;
      return initialDeadline;
    },
    async commit(state) {
      if (phase === 'SEALED') throw fail('COLLECTION_SEALED');
      const document = JSON.parse(canonical({ schemaVersion: 3, phase: 'OPEN', binding, initialDeadline, state, stateHash: hash(state) }));
      const next = check(document);
      await store.save(binding.runId, binding.collectionId, document);
      current = next; exists = true; return this.state;
    },
    async seal(payload, expectedStateHash) {
      if (phase === 'SEALED') {
        if (hash(payload) !== submission.payloadHash) throw fail('SEALED_PAYLOAD_MISMATCH');
        return this.submission;
      }
      if (current === null || hash(current) !== expectedStateHash) throw fail('DRAFT_CHANGED');
      const document = JSON.parse(canonical(sealedDocument(payload, hash(current), initialDeadline, randomUUID())));
      check(document);
      await store.save(binding.runId, binding.collectionId, document);
      phase = 'SEALED'; current = null; submission = document.submission;
      return this.submission;
    }
  };
}

export const realClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(fail('CANCELLED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  })
};
export function createLimiter() {
  let nextAt = 0;
  return {
    defer(until) { nextAt = Math.max(nextAt, until); },
    async acquire(ctx, spacing) {
      // 平台串行执行；共享实例协调同 worker 的所有只读请求。
      await ctx.wait(Math.max(0, nextAt - ctx.now()));
      nextAt = ctx.now() + spacing;
    }
  };
}
const workerLimiter = createLimiter();

function bindingFor(plugin, options, config) {
  return { runId: options.runId, collectionId: options.collectionId, collectionSeq: options.collectionSeq,
    taskSnapshotRef: options.taskSnapshotRef ?? null, pluginId: plugin.manifest.id, pluginVersion: plugin.manifest.version, configHash: hash(config) };
}
function collectionCheckpoint(plugin, options) {
  id(options.runId); id(options.collectionId);
  const config = plugin.validateConfig(options.config ?? {});
  return checkpoint({ store: options.store ?? new JsonCheckpointStore({ maxBytes: options.maxBytes }), maxBytes: options.maxBytes,
    binding: bindingFor(plugin, options, config), validateState: plugin.validateState,
    payloadForState: typeof plugin.snapshotResult === 'function' ? state => snapshotPayload(plugin, options, config, state) : undefined });
}

function snapshotPayload(plugin, options, config, state) {
  if (typeof plugin.snapshotResult !== 'function') throw fail('DRAFT_READER_REQUIRED');
  return { ...plugin.snapshotResult({ ...options, config }, state), taskSnapshotRef: options.taskSnapshotRef ?? null };
}

// 显式封存当前草稿；不访问页面。宿主决定何时结束 OPEN，包括最终 partial。
export async function sealPluginResult(plugin, options, draft) {
  const cp = collectionCheckpoint(plugin, options); await cp.load();
  if (draft?.checkpoint?.phase !== 'OPEN' || draft.collectionId !== options.collectionId || draft.collectionSeq !== options.collectionSeq || draft.taskSnapshotRef !== (options.taskSnapshotRef ?? null)) throw fail('INVALID_DRAFT');
  const { checkpoint: metadata, ...payload } = draft;
  if (cp.phase === 'SEALED') return cp.seal(payload, metadata.stateHash);
  if (cp.state === null || hash(cp.state) !== metadata.stateHash) throw fail('DRAFT_CHANGED');
  const authoritative = snapshotPayload(plugin, options, plugin.validateConfig(options.config ?? {}), cp.state);
  if (hash(payload) !== hash(authoritative)) throw fail('DRAFT_PAYLOAD_MISMATCH');
  return cp.seal(authoritative, metadata.stateHash);
}
export async function readOpenDraft(plugin, options) {
  const cp = collectionCheckpoint(plugin, options); await cp.load();
  if (cp.phase !== 'OPEN') throw fail('COLLECTION_SEALED');
  if (cp.state === null) throw fail('CHECKPOINT_NOT_FOUND');
  if (typeof plugin.snapshotResult !== 'function') throw fail('DRAFT_READER_REQUIRED');
  const config = plugin.validateConfig(options.config ?? {});
  return { ...plugin.snapshotResult({ ...options, config }, cp.state), taskSnapshotRef: options.taskSnapshotRef ?? null,
    checkpoint: { phase: 'OPEN', stateHash: hash(cp.state) } };
}
export async function readSealedSubmission(plugin, options) {
  const cp = collectionCheckpoint(plugin, options); await cp.load();
  if (cp.phase !== 'SEALED') throw fail('COLLECTION_NOT_SEALED');
  return cp.submission;
}

// 不发现或抢占 Chrome。withPage 必须由持有档案独占租约的宿主注入。
export async function runPlugin(plugin, options) {
  const { runId, collectionId, collectionSeq, signal, withPage, store = new JsonCheckpointStore({ maxBytes: options.maxBytes }), clock = realClock,
    limiter = workerLimiter, progress = () => {} } = options;
  id(runId); id(collectionId);
  if (!Number.isSafeInteger(collectionSeq) || collectionSeq < 1) throw fail('INVALID_COLLECTION');
  if (plugin.manifest.engineApiVersion !== '1') throw fail('ENGINE_API_MISMATCH');
  if (typeof withPage !== 'function') throw fail('PAGE_LEASE_REQUIRED');
  const config = Object.freeze(plugin.validateConfig(options.config ?? {}));
  let deadline = Date.parse(options.deadline);
  if (!Number.isFinite(deadline)) throw fail('INVALID_DEADLINE');
  const binding = bindingFor(plugin, options, config);
  const cp = collectionCheckpoint(plugin, { ...options, store });
  const check = () => {
    if (signal?.aborted) throw fail('CANCELLED');
    if (clock.now() >= deadline) throw fail('DEADLINE_EXCEEDED');
  };
  const ctx = {
    config, ...binding, signal, deadline, now: clock.now, checkpoint: cp,
    check,
    constrainDeadline(until) {
      if (!Number.isFinite(until)) throw fail('INVALID_DEADLINE');
      deadline = Math.min(deadline, until); ctx.deadline = deadline; check();
    },
    async wait(ms) {
      check();
      if (!Number.isFinite(ms) || ms < 0) throw fail('INVALID_WAIT');
      if (clock.now() + ms >= deadline) throw fail('DEADLINE_EXCEEDED');
      await clock.sleep(ms, signal); check();
    },
    async withPage(fn) {
      check();
      const leaseAbort = new AbortController();
      const leaseSignal = AbortSignal.any([...(signal ? [signal] : []), leaseAbort.signal]);
      const timer = setTimeout(() => leaseAbort.abort(), Math.min(2147483647, Math.max(1, deadline - clock.now())));
      const bounded = async operation => {
        check();
        if (leaseSignal.aborted) throw fail(signal?.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED');
        let abort;
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => {
              check();
              if (leaseSignal.aborted) throw fail(signal?.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED');
              return operation();
            }),
            new Promise((_, reject) => {
              abort = () => reject(fail(signal?.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED'));
              leaseSignal.addEventListener('abort', abort, { once: true });
            })
          ]);
          check(); return result;
        } finally { leaseSignal.removeEventListener('abort', abort); }
      };
      try {
        return await withPage(async page => {
          check();
          const guarded = new Proxy(page, { get(target, key) {
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? (...args) => bounded(() => value.apply(target, args)) : value;
          } });
          const result = await fn(guarded); check(); return result;
        }, { signal: leaseSignal, deadline });
      } finally { clearTimeout(timer); leaseAbort.abort(); }
    },
    async throttle(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw fail('INVALID_WAIT');
      await limiter.acquire(ctx, Math.max(3000, ms));
    },
    defer(until) { limiter.defer(until); },
    // 普通日志只暴露受控 item key/错误码；正文仅进入 spool。
    progress(itemKey, code) {
      if (!/^[A-Za-z0-9_.\/-]{1,220}$/.test(itemKey) || !/^[A-Z_]{1,60}$/.test(code)) throw fail('INVALID_PROGRESS');
      progress({ itemKey, code });
    },
    async commit(state) { check(); return cp.commit(state); }
  };
  check(); await cp.load();
  deadline = Math.min(deadline, cp.initialDeadline ?? deadline);
  ctx.deadline = deadline;
  check();
  if (options.resume && !cp.exists) throw fail('CHECKPOINT_NOT_FOUND');
  if (cp.phase === 'SEALED') throw fail('COLLECTION_SEALED');
  if (cp.exists) {
    if (typeof options.authorizeResume !== 'function') throw fail('RESUME_AUTHORIZATION_REQUIRED');
    // 只有宿主能核验有效租约/独占/中心水位/无更新 collection；本地不伪造中心证据。
    if (await options.authorizeResume({ binding: structuredClone(binding), stateHash: hash(cp.state), state: cp.state, deadline }) !== true) throw fail('RESUME_NOT_AUTHORIZED');
    check();
  }
  await cp.start(deadline); check();
  const result = await plugin.collect(ctx);
  return { ...result, taskSnapshotRef: binding.taskSnapshotRef, checkpoint: { phase: 'OPEN', stateHash: hash(cp.state) } };
}
