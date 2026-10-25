import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash } from '../../packages/plugin-sdk/index.js';
import { configFor, plugins, validateSubmission } from './registry.js';
import { check, key, object } from './errors.js';

const terminal = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);
const encode = JSON.stringify;
const decode = row => row ? JSON.parse(row.doc) : null;
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
export class Store {
  constructor({ filename = '/data/database/page-gather.sqlite', workerId = 'worker-main', seed = true, now = Date.now } = {}) {
    this.workerId = key(workerId); this.now = now;
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, committed_seq INTEGER NOT NULL DEFAULT 0, holder TEXT);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, doc TEXT NOT NULL CHECK(json_valid(doc)));
      CREATE TABLE IF NOT EXISTS runs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(id), request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, doc TEXT NOT NULL CHECK(json_valid(doc)));
      CREATE TABLE IF NOT EXISTS claims(worker_id TEXT NOT NULL, request_key TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), lease TEXT NOT NULL CHECK(json_valid(lease)), PRIMARY KEY(worker_id,request_key));
      CREATE TABLE IF NOT EXISTS collections(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs(id), registration_key TEXT NOT NULL, doc TEXT NOT NULL CHECK(json_valid(doc)), UNIQUE(run_id, registration_key));
      CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), collection_id TEXT NOT NULL UNIQUE REFERENCES collections(id), payload_hash TEXT NOT NULL, receipt TEXT NOT NULL CHECK(json_valid(receipt)), payload TEXT NOT NULL CHECK(json_valid(payload)), archived_payload TEXT CHECK(archived_payload IS NULL OR json_valid(archived_payload)));
      CREATE TABLE IF NOT EXISTS entities(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profiles(id), entity_type TEXT NOT NULL, source_key TEXT NOT NULL, doc TEXT NOT NULL CHECK(json_valid(doc)), UNIQUE(source, profile_id, entity_type, source_key));
      CREATE TABLE IF NOT EXISTS versions(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, entity_id TEXT NOT NULL REFERENCES entities(id), run_id TEXT NOT NULL REFERENCES runs(id), fingerprint TEXT NOT NULL, doc TEXT NOT NULL CHECK(json_valid(doc)));
      CREATE TABLE IF NOT EXISTS submission_items(submission_id TEXT NOT NULL REFERENCES submissions(id), ordinal INTEGER NOT NULL, version_id TEXT NOT NULL REFERENCES versions(id), metadata TEXT NOT NULL CHECK(json_valid(metadata)), PRIMARY KEY(submission_id,ordinal));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, version_id TEXT NOT NULL UNIQUE REFERENCES versions(id), doc TEXT NOT NULL CHECK(json_valid(doc)));
      CREATE TABLE IF NOT EXISTS baselines(task_id TEXT NOT NULL REFERENCES tasks(id), scope_key TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), PRIMARY KEY(task_id,scope_key));
      CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY, doc TEXT NOT NULL CHECK(json_valid(doc)));
      CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
      CREATE INDEX IF NOT EXISTS versions_entity ON versions(entity_id,seq);
      INSERT OR IGNORE INTO profiles(id) VALUES('main');`);
    this.tx(() => {
      for (const row of this.db.prepare('SELECT doc FROM runs').all()) {
        const run = decode(row);
        if (run.status === 'RUNNING') { run.status = 'RECOVERING'; run.error = { code: 'SERVER_RESTARTED' }; this.saveRun(run); }
      }
      if (seed && !this.db.prepare('SELECT id FROM tasks LIMIT 1').get()) this.createTask({ name: 'GitHub 每日榜 README', pluginId: plugins[0].id, pluginVersion: plugins[0].version, profileId: 'main', config: {}, enabled: true });
    });
    this.migrateBodyStorage();
    this.migrateEntityMetadata();
  }
  close() { this.db.close(); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  iso() { return new Date(this.now()).toISOString(); }
  getTask(id) { const task = decode(this.db.prepare('SELECT doc FROM tasks WHERE id=?').get(id)); check(task, 'TASK_NOT_FOUND', 404); return task; }
  createTask(input) {
    const task = this.taskInput(input);
    task.id = randomUUID(); task.createdAt = this.iso(); task.updatedAt = task.createdAt;
    this.db.prepare('INSERT INTO tasks VALUES(?,?)').run(task.id, encode(task)); return task;
  }
  taskInput(input, previous = {}) {
    check(object(input) && Object.keys(input).every(k => ['name','pluginId','pluginVersion','profileId','config','enabled'].includes(k)), 'INVALID_TASK', 400);
    const task = { profileId: 'main', enabled: true, ...previous, ...input };
    check(typeof task.name === 'string' && task.name.trim().length > 0 && task.name.length <= 200 && task.profileId === 'main' && typeof task.enabled === 'boolean', 'INVALID_TASK', 400);
    task.config = configFor(task.pluginId, task.pluginVersion, task.config ?? {}); return task;
  }
  patchTask(id, input) {
    return this.tx(() => { const task = this.taskInput(input, this.getTask(id)); task.updatedAt = this.iso(); this.db.prepare('UPDATE tasks SET doc=? WHERE id=?').run(encode(task), id); return task; });
  }
  createRun(taskId, requestKey, request = {}) {
    key(requestKey, 'INVALID_IDEMPOTENCY_KEY');
    return this.tx(() => {
      const requestHash = hash({ taskId, request });
      const old = this.db.prepare('SELECT * FROM runs WHERE request_key=?').get(requestKey);
      if (old) { check(old.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT'); return decode(old); }
      const task = this.getTask(taskId); check(task.enabled, 'TASK_DISABLED');
      const createdAt = this.iso();
      const snapshot = { taskId, name: task.name, pluginId: task.pluginId, pluginVersion: task.pluginVersion, profileId: task.profileId, config: task.config };
      const run = { id: randomUUID(), ...snapshot, taskSnapshot: snapshot, configSnapshot: task.config, taskSnapshotRef: randomUUID(), trigger: 'manual', status: 'QUEUED', stage: 'COLLECT', phase: 'COLLECT', createdAt, updatedAt: createdAt, attempt: 0, fencingToken: 0, leaseOwner: null, leaseUntil: null, deadline: null, cancelRequested: false, progress: null, error: null, resultSummary: null, outcome: null, uploadOnly: false };
      this.db.prepare('INSERT INTO runs(id,task_id,request_key,request_hash,doc) VALUES(?,?,?,?,?)').run(run.id, taskId, requestKey, requestHash, encode(run)); return run;
    });
  }
  run(id) { const run = decode(this.db.prepare('SELECT doc FROM runs WHERE id=?').get(id)); check(run, 'RUN_NOT_FOUND', 404); return run; }
  saveRun(run) { run.updatedAt = this.iso(); this.db.prepare('UPDATE runs SET doc=? WHERE id=?').run(encode(run), run.id); }
  expire() {
    for (const row of this.db.prepare("SELECT doc FROM runs WHERE json_extract(doc,'$.status')='RUNNING'").all()) {
      const run = decode(row);
      if (Date.parse(run.leaseUntil) <= this.now()) { run.status = 'RECOVERING'; run.error = { code: 'WORKER_LOST' }; this.saveRun(run); }
    }
  }
  identity(body, run) { check(body?.workerId === this.workerId && (!run || run.leaseOwner === body.workerId), 'WORKER_IDENTITY_MISMATCH', 403); }
  lease(run, body, { collect = false } = {}) {
    this.identity(body, run);
    const profile = this.db.prepare('SELECT * FROM profiles WHERE id=?').get(run.profileId);
    check(body.attempt === run.attempt && body.fencingToken === run.fencingToken && Date.parse(run.leaseUntil) > this.now() && profile.holder === run.id, 'LEASE_INVALID');
    check(['RUNNING','RECOVERING'].includes(run.status), 'RUN_TERMINAL');
    if (collect) check(!run.uploadOnly && !run.finalizationOnly && !run.cancelRequested && run.status === 'RUNNING' && Date.parse(run.deadline) > this.now(), 'COLLECTION_NOT_AUTHORIZED');
  }
  workerStatus(body) {
    this.identity(body);
    check(['AUTO','MANUAL','MANUAL_REQUESTED','RECOVERING','PAUSED'].includes(body.mode) && typeof body.busy === 'boolean' && (body.activeRunId === null || typeof body.activeRunId === 'string'), 'INVALID_WORKER_STATUS', 400);
    if (body.activeRunId !== null) key(body.activeRunId,'INVALID_ACTIVE_RUN_ID');
    const worker = { id: this.workerId, workerId: this.workerId, mode: body.mode, busy: body.busy, activeRunId: body.activeRunId, lastHeartbeatAt: this.iso() };
    this.db.prepare('INSERT INTO workers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc').run(this.workerId, encode(worker)); return worker;
  }
  claim(body) {
    this.identity(body); key(body.requestKey,'INVALID_CLAIM_REQUEST_KEY');
    return this.tx(() => {
      this.expire();
      const previous = this.db.prepare('SELECT * FROM claims WHERE worker_id=? AND request_key=?').get(body.workerId,body.requestKey);
      if (previous) {
        const run = this.run(previous.run_id); const lease = JSON.parse(previous.lease);
        const executable = run.status === 'RUNNING' && !run.cancelRequested && !run.uploadOnly && !run.finalizationOnly && Date.parse(lease.leaseUntil) > this.now() + 5000 && run.fencingToken === lease.fencingToken && !this.db.prepare('SELECT id FROM collections WHERE run_id=? LIMIT 1').get(run.id);
        return { run,lease,action: executable ? 'execute' : 'finalize_only',requestKey:body.requestKey,replayed:true };
      }
      const worker = decode(this.db.prepare('SELECT doc FROM workers WHERE id=?').get(this.workerId));
      // 公开GitHub无需站点登录；PAUSED不阻止只读领取。poller在本地runExternal锁中claim，busy且无activeRunId为正常领取状态。
      if (worker && (worker.mode.startsWith('MANUAL') || worker.activeRunId || this.now() - Date.parse(worker.lastHeartbeatAt) > 90000)) return null;
      if (this.db.prepare("SELECT holder FROM profiles WHERE id='main'").get().holder) return null;
      const rows = this.db.prepare("SELECT r.doc FROM runs r JOIN tasks t ON t.id=r.task_id WHERE json_extract(r.doc,'$.status')='QUEUED' AND json_extract(t.doc,'$.enabled')=1 ORDER BY r.seq LIMIT 1").all();
      if (!rows.length) return null;
      const run = decode(rows[0]); run.status = 'RUNNING'; run.leaseOwner = this.workerId; run.attempt++; run.fencingToken++; run.startedAt ??= this.iso();
      // 队列和每项两次只读预算，最长一小时；SDK仍会收紧到UTC午夜。
      run.deadline ??= new Date(this.now() + Math.min(3600000, Math.max(600000, (run.config.maxRepos * 2 + 1) * (run.config.itemDelayMs + 30000)))).toISOString();
      run.leaseUntil = new Date(this.now() + 90000).toISOString();
      this.db.prepare("UPDATE profiles SET holder=? WHERE id='main' AND holder IS NULL").run(run.id);
      this.saveRun(run);
      const lease = this.leaseView(run);
      this.db.prepare('INSERT INTO claims VALUES(?,?,?,?)').run(body.workerId,body.requestKey,run.id,encode(lease));
      return { run,lease,action:'execute',requestKey:body.requestKey,replayed:false };
    });
  }
  leaseView(run) { return { attempt: run.attempt, fencingToken: run.fencingToken, leaseUntil: run.leaseUntil }; }
  collection(id, runId) {
    const row = this.db.prepare('SELECT * FROM collections WHERE id=? AND run_id=?').get(id, runId); check(row, 'COLLECTION_NOT_FOUND', 404);
    return { ...decode(row), seq: row.seq };
  }
  saveCollection(c) { this.db.prepare('UPDATE collections SET doc=? WHERE id=?').run(encode(c), c.id); }
  register(runId, body) {
    key(body.registrationKey, 'INVALID_REGISTRATION_KEY');
    return this.tx(() => {
      const run = this.run(runId); this.lease(run, body, { collect: true });
      const old = this.db.prepare('SELECT * FROM collections WHERE run_id=? AND registration_key=?').get(runId, body.registrationKey);
      if (old) { const c = decode(old); return { collectionId: c.id, collectionSeq: old.seq, taskSnapshotRef: c.taskSnapshotRef }; }
      const c = { id: randomUUID(), runId, profileId: run.profileId, taskSnapshotRef: run.taskSnapshotRef, attempt: run.attempt, lifecycle: 'OPEN', submissionId: null, payloadHash: null, createdAt: this.iso() };
      const result = this.db.prepare('INSERT INTO collections(id,run_id,registration_key,doc) VALUES(?,?,?,?)').run(c.id, runId, body.registrationKey, encode(c));
      c.seq = Number(result.lastInsertRowid); this.saveCollection(c);
      return { collectionId: c.id, collectionSeq: c.seq, taskSnapshotRef: c.taskSnapshotRef };
    });
  }
  validProgress(p) {
    check(object(p) && Object.keys(p).every(k => ['phase','itemKey','completed','total','code'].includes(k)), 'INVALID_PROGRESS', 400);
    if (p.phase !== undefined) check(safeCode(p.phase), 'INVALID_PROGRESS', 400);
    if (p.code !== undefined) check(safeCode(p.code), 'INVALID_PROGRESS', 400);
    if (p.itemKey !== undefined) check(typeof p.itemKey === 'string' && /^[A-Za-z0-9_.\/-]{1,220}$/.test(p.itemKey), 'INVALID_PROGRESS', 400);
    for (const k of ['completed','total']) if (p[k] !== undefined) check(Number.isSafeInteger(p[k]) && p[k] >= 0 && p[k] <= 100, 'INVALID_PROGRESS', 400);
    if (p.completed !== undefined && p.total !== undefined) check(p.completed <= p.total,'INVALID_PROGRESS',400);
    return p;
  }
  heartbeat(runId, body) {
    return this.tx(() => {
      const run = this.run(runId); this.lease(run, body);
      if (body.progress !== undefined) run.progress = this.validProgress(body.progress);
      run.leaseUntil = new Date(this.now() + 90000).toISOString(); this.saveRun(run);
      return { cancelRequested: run.cancelRequested, leaseUntil: run.leaseUntil };
    });
  }
  submissionIdentity(run, c, submission) {
    key(submission?.submissionId, 'INVALID_SUBMISSION_ID');
    check(submission.collectionId === c.id && submission.collectionSeq === c.seq, 'COLLECTION_BINDING_MISMATCH');
    if (c.submissionId) check(c.submissionId === submission.submissionId && c.payloadHash === submission.payloadHash, 'SEALED_SUBMISSION_CONFLICT');
    const old = this.db.prepare('SELECT * FROM submissions WHERE id=? OR collection_id=?').get(submission.submissionId, c.id);
    if (old) {
      check(old.run_id === run.id && old.collection_id === c.id && old.id === submission.submissionId && old.payload_hash === submission.payloadHash, 'SUBMISSION_CONFLICT');
      return JSON.parse(old.receipt);
    }
    return null;
  }
  seal(runId, collectionId, body) {
    const run = this.run(runId); this.identity(body, run);
    const c = this.collection(collectionId, runId); const s = body.submission;
    validateSubmission(s, c, run); // hash和schema工作在短事务之外。
    return this.tx(() => {
      const current = this.run(runId); this.identity(body, current);
      const currentCollection = this.collection(collectionId, runId);
      const receipt = this.submissionIdentity(current, currentCollection, s);
      if (!receipt) { this.lease(current, body); check(!current.finalizationOnly,'FINALIZATION_ONLY'); }
      if (!currentCollection.submissionId) {
        currentCollection.submissionId = s.submissionId; currentCollection.payloadHash = s.payloadHash; currentCollection.lifecycle = 'SEALED'; this.saveCollection(currentCollection);
      }
      if (!terminal.has(current.status)) { current.stage = 'SEAL'; current.phase = 'SEAL'; this.saveRun(current); }
      return { collectionId, collectionSeq: c.seq, submissionId: s.submissionId, payloadHash: s.payloadHash, lifecycle: currentCollection.lifecycle, ...(receipt ? { receipt } : {}) };
    });
  }
  submit(runId, body) {
    const run = this.run(runId); this.identity(body, run);
    const c = this.collection(body.submission?.collectionId, runId); const s = body.submission;
    const payload = validateSubmission(s, c, run);
    return this.tx(() => {
      const current = this.run(runId); this.identity(body, current);
      const currentCollection = this.collection(c.id, runId);
      const old = this.submissionIdentity(current, currentCollection, s); if (old) return { receipt: old };
      this.lease(current, body); check(!current.finalizationOnly,'FINALIZATION_ONLY');
      check(currentCollection.lifecycle === 'SEALED' && currentCollection.submissionId === s.submissionId && currentCollection.payloadHash === s.payloadHash, 'COLLECTION_NOT_SEALED');
      const committed = this.db.prepare('SELECT committed_seq FROM profiles WHERE id=?').get(run.profileId).committed_seq;
      check(c.seq !== committed, 'WATERMARK_CONFLICT');
      const stale = c.seq < committed;
      const counts = { items: payload.items.length, created: 0, changed: 0, unchanged: 0 };
      const itemLinks = [];
      if (!stale) {
        for (const item of payload.items) itemLinks.push({ versionId: this.applyItem(run, item, counts), metadata: this.itemMetadata(item) });
        this.db.prepare('UPDATE profiles SET committed_seq=? WHERE id=?').run(c.seq, run.profileId);
        if (payload.completeness === 'complete') this.db.prepare('INSERT INTO baselines VALUES(?,?,?) ON CONFLICT(task_id,scope_key) DO UPDATE SET run_id=excluded.run_id').run(run.taskId, payload.scopeKey, run.id);
      }
      const receipt = { submissionId: s.submissionId, collectionId: c.id, collectionSeq: c.seq, disposition: stale ? 'stale' : 'applied', committedSeqAtDecision: stale ? committed : c.seq, archived: stale, counts };
      const storedPayload = stale ? { storageVersion: 1, archived: true } : this.compactPayload(payload);
      this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?)').run(s.submissionId, run.id, c.id, s.payloadHash, encode(receipt), encode(storedPayload), stale ? encode(payload) : null);
      for (const [ordinal, link] of itemLinks.entries()) this.db.prepare('INSERT INTO submission_items VALUES(?,?,?,?)').run(s.submissionId, ordinal, link.versionId, encode(link.metadata));
      currentCollection.lifecycle = stale ? 'STALE' : 'APPLIED'; this.saveCollection(currentCollection);
      current.stage = 'UPLOAD'; current.phase = 'UPLOAD'; current.resultSummary = { completeness: payload.completeness, ...counts, disposition: receipt.disposition, collectionSeq: c.seq }; this.saveRun(current);
      return { receipt };
    });
  }
  applyItem(run, item, counts) {
    let entity = decode(this.db.prepare('SELECT doc FROM entities WHERE source=? AND profile_id=? AND entity_type=? AND source_key=?').get(run.pluginId, run.profileId, 'repository_readme', item.sourceKey));
    const fingerprint = item.contentHash;
    const existing = !!entity;
    if (!entity) {
      entity = { id: randomUUID(), source: run.pluginId, profileId: run.profileId, entityType: 'repository_readme', sourceKey: item.sourceKey, sourceUrl: item.sourceUrl, firstSeenAt: item.observedAt, lastSeenAt: item.observedAt, currentVersionId: null, fingerprint: null };
      this.db.prepare('INSERT INTO entities(id,source,profile_id,entity_type,source_key,doc) VALUES(?,?,?,?,?,?)').run(entity.id, run.pluginId, run.profileId, entity.entityType, item.sourceKey, encode(entity));
    }
    if (entity.fingerprint !== fingerprint) {
      const version = { id: randomUUID(), entityId: entity.id, runId: run.id, fingerprint, sourceKey: item.sourceKey, sourceUrl: item.sourceUrl, readme: item.readme, observedAt: item.observedAt };
      this.db.prepare('INSERT INTO versions(id,entity_id,run_id,fingerprint,doc) VALUES(?,?,?,?,?)').run(version.id, entity.id, run.id, fingerprint, encode(version));
      const event = { id: randomUUID(), versionId: version.id, kind: existing ? 'changed' : 'created' };
      this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(event.id, version.id, encode(event));
      entity.currentVersionId = version.id; entity.fingerprint = fingerprint;
      counts[existing ? 'changed' : 'created']++;
    } else counts.unchanged++;
    entity.lastSeenAt = item.observedAt; entity.sourceUrl = item.sourceUrl; entity.readmeStatus = item.readme.status;
    this.db.prepare('UPDATE entities SET doc=? WHERE id=?').run(encode(entity), entity.id);
    return entity.currentVersionId;
  }
  outcome(runId, body) {
    this.tx(() => {
      const run = this.run(runId); this.identity(body, run);
      check(terminal.has(body.status), 'INVALID_OUTCOME', 400);
      if (body.errorCode != null) check(safeCode(body.errorCode), 'INVALID_ERROR_CODE', 400);
      // summary只接纳数值计数/枚举，拒绝页面正文或路径进入状态信息。
      if (body.summary != null) check(object(body.summary) && Object.entries(body.summary).every(([k,v]) => /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k) && (typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean' || typeof v === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(v))), 'INVALID_SUMMARY', 400);
      if (terminal.has(run.status)) { check(run.outcome?.status === body.status && run.outcome?.errorCode === (body.errorCode ?? null) && hash(run.outcome?.summary ?? null) === hash(body.summary ?? null), 'OUTCOME_CONFLICT'); return; }
      this.lease(run, body);
      if (['SUCCEEDED','PARTIAL'].includes(body.status)) check(this.db.prepare('SELECT id FROM submissions WHERE run_id=? LIMIT 1').get(runId), 'RECEIPT_REQUIRED');
      if (body.progress !== undefined) run.progress = this.validProgress(body.progress);
      run.status = run.cancelRequested ? 'CANCELLED' : body.status;
      run.outcome = { status: body.status, errorCode: body.errorCode ?? null, summary: body.summary ?? null };
      run.error = body.errorCode ? { code: body.errorCode } : null; run.finishedAt = this.iso(); run.leaseUntil = null;
      this.saveRun(run); this.db.prepare('UPDATE profiles SET holder=NULL WHERE id=? AND holder=?').run(run.profileId, runId);
    });
    return { run: this.getRun(runId) };
  }
  cancel(runId) {
    this.tx(() => {
      const run = this.run(runId);
      if (!terminal.has(run.status)) { run.cancelRequested = true; if (run.status === 'QUEUED') { run.status = 'CANCELLED'; run.finishedAt = this.iso(); } this.saveRun(run); }
    });
    return { run: this.getRun(runId) };
  }
  recoverFinalization(runId, body) {
    return this.tx(() => {
      this.expire(); const run = this.run(runId); this.identity(body,run);
      check(body.stopped === true,'STOP_CONFIRMATION_REQUIRED',400);
      const worker = decode(this.db.prepare('SELECT doc FROM workers WHERE id=?').get(body.workerId));
      check(worker && worker.busy && worker.activeRunId === runId && !worker.mode.startsWith('MANUAL') && this.now()-Date.parse(worker.lastHeartbeatAt) < 90000,'RECOVERY_LOCK_REQUIRED');
      if (terminal.has(run.status)) return { action:'terminal',run,outcome:run.outcome };
      const holder = this.db.prepare('SELECT holder FROM profiles WHERE id=?').get(run.profileId).holder;
      if (holder && holder !== runId) return { action:'blocked',reason:'PROFILE_BUSY' };
      run.attempt++; run.fencingToken++; run.uploadOnly = true; run.finalizationOnly = true;
      run.status = 'RECOVERING'; run.stage = 'UPLOAD'; run.phase = 'FINALIZE'; run.leaseUntil = new Date(this.now()+90000).toISOString();
      this.db.prepare('UPDATE profiles SET holder=? WHERE id=?').run(run.id,run.profileId); this.saveRun(run);
      return { action:'finalize_only',run,lease:this.leaseView(run) };
    });
  }
  recover(runId, body) {
    key(body.submissionId, 'INVALID_SUBMISSION_ID');
    check(typeof body.payloadHash === 'string' && /^[a-f0-9]{64}$/.test(body.payloadHash), 'INVALID_PAYLOAD_HASH', 400);
    return this.tx(() => {
      this.expire(); const run = this.run(runId); this.identity(body, run);
      const c = this.collection(body.collectionId, runId);
      const prior = this.submissionIdentity(run, c, { ...body, collectionSeq: c.seq });
      if (terminal.has(run.status)) return { action:prior ? 'replay_receipt' : 'terminal',...(prior ? { receipt:prior } : {}),run,outcome:run.outcome };
      check(!run.finalizationOnly,'FINALIZATION_ONLY');
      const holder = this.db.prepare('SELECT holder FROM profiles WHERE id=?').get(run.profileId).holder;
      const worker = decode(this.db.prepare('SELECT doc FROM workers WHERE id=?').get(this.workerId));
      const blockedReason = holder && holder !== runId ? 'PROFILE_BUSY' : worker && (worker.mode.startsWith('MANUAL') || worker.busy && worker.activeRunId !== runId || worker.activeRunId && worker.activeRunId !== runId) ? 'WORKER_BUSY' : null;
      // 原收据优先；若终态尚未确认，还需授权worker补报outcome，不能留下永久档案锁。
      if (prior && (terminal.has(run.status) || blockedReason)) return { action: 'replay_receipt', receipt: prior, run };
      if (blockedReason) return { action: 'blocked', reason: blockedReason };
      // 同一部署worker的spool恢复请求是旧页面已停止的确认；新凭据不能注册其他worker。
      // 本地先SEALED、中心seal响应可能丢失，OPEN记录也只能固定该包并授予上传。
      c.submissionId = body.submissionId; c.payloadHash = body.payloadHash; if (!prior) c.lifecycle = 'SEALED'; this.saveCollection(c);
      run.attempt++; run.fencingToken++; run.uploadOnly = true; run.status = 'RECOVERING'; run.stage = 'UPLOAD'; run.phase = 'UPLOAD'; run.leaseUntil = new Date(this.now() + 90000).toISOString();
      this.db.prepare('UPDATE profiles SET holder=? WHERE id=?').run(run.id, run.profileId); this.saveRun(run);
      const committed = this.db.prepare('SELECT committed_seq FROM profiles WHERE id=?').get(run.profileId).committed_seq;
      if (prior) return { action: 'replay_receipt', receipt: prior, lease: this.leaseView(run), run };
      return { action: c.seq < committed ? 'stale' : 'authorize_upload', lease: this.leaseView(run), run };
    });
  }
  itemMetadata(item) { const { readme, ...metadata } = item; return metadata; }
  compactPayload(payload) { const { items, ...metadata } = payload; return { storageVersion: 1, payload: metadata }; }
  versionView(version) { return version; }
  entityView(entity) {
    const version = decode(this.db.prepare('SELECT doc FROM versions WHERE id=?').get(entity.currentVersionId));
    check(version, 'STORED_VERSION_MISSING',500);
    return { ...entity, readme: version.readme };
  }
  entityMetadata(entity) {
    const { readme,fields,...metadata } = entity;
    return metadata;
  }
  migrateEntityMetadata() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 2) return;
    for (const row of this.db.prepare('SELECT id,doc FROM entities').all()) {
      const entity = decode(row);
      const version = this.db.prepare("SELECT json_extract(doc,'$.readme.status') AS status FROM versions WHERE id=?").get(entity.currentVersionId);
      check(version,'STORED_VERSION_MISSING',500); entity.readmeStatus = version.status;
      this.db.prepare('UPDATE entities SET doc=? WHERE id=?').run(encode(entity),row.id);
    }
    this.db.exec('PRAGMA user_version=2');
  }
  restorePayload(row) {
    let payload;
    if (row.archived_payload !== null) payload = JSON.parse(row.archived_payload);
    else {
      const stored = JSON.parse(row.payload);
      if (stored.storageVersion !== 1) payload = stored;
      else {
        const items = this.db.prepare('SELECT i.metadata,v.doc FROM submission_items i JOIN versions v ON v.id=i.version_id WHERE i.submission_id=? ORDER BY i.ordinal').all(row.id).map(item => ({ ...JSON.parse(item.metadata), readme: decode(item).readme }));
        payload = { ...stored.payload, items };
      }
    }
    check(hash(payload) === row.payload_hash, 'STORED_PAYLOAD_HASH_MISMATCH',500);
    return payload;
  }
  migrateBodyStorage() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 1) return;
    // 兼容本轮早期开发数据库；逐提交短事务保留原身份/hash/收据，不丢失已有run结果。
    for (const { id } of this.db.prepare('SELECT id FROM submissions').all()) this.tx(() => {
      const row = this.db.prepare('SELECT * FROM submissions WHERE id=?').get(id);
      const stored = JSON.parse(row.payload); if (stored.storageVersion === 1) return;
      const payload = this.restorePayload(row);
      if (row.archived_payload !== null) this.db.prepare('UPDATE submissions SET payload=? WHERE id=?').run(encode({ storageVersion: 1, archived: true }), id);
      else {
        const run = this.run(row.run_id);
        const links = payload.items.map(item => {
          const version = this.db.prepare('SELECT v.id,v.doc FROM versions v JOIN entities e ON e.id=v.entity_id WHERE e.source=? AND e.profile_id=? AND e.entity_type=? AND e.source_key=? AND v.fingerprint=? ORDER BY v.seq LIMIT 1').get(run.pluginId,run.profileId,'repository_readme',item.sourceKey,item.contentHash);
          check(version && hash(decode(version).readme) === hash(item.readme), 'STORED_VERSION_MISSING',500);
          return { versionId: version.id, metadata: this.itemMetadata(item) };
        });
        for (const [ordinal, link] of links.entries()) this.db.prepare('INSERT INTO submission_items VALUES(?,?,?,?)').run(id,ordinal,link.versionId,encode(link.metadata));
        this.db.prepare('UPDATE submissions SET payload=? WHERE id=?').run(encode(this.compactPayload(payload)),id);
      }
      this.restorePayload(this.db.prepare('SELECT * FROM submissions WHERE id=?').get(id));
    });
    for (const table of ['entities','versions']) {
      for (const { id } of this.db.prepare(`SELECT id FROM ${table}`).all()) {
        const document = decode(this.db.prepare(`SELECT doc FROM ${table} WHERE id=?`).get(id));
        delete document.fields; if (table === 'entities') delete document.readme;
        this.db.prepare(`UPDATE ${table} SET doc=? WHERE id=?`).run(encode(document),id);
      }
    }
    this.db.exec('PRAGMA user_version=1');
  }
  getRun(id) {
    const run = this.run(id);
    const collections = this.db.prepare('SELECT doc FROM collections WHERE run_id=? ORDER BY seq').all(id).map(decode);
    const submissions = this.db.prepare('SELECT * FROM submissions WHERE run_id=? ORDER BY rowid').all(id).map(row => ({ payload: this.restorePayload(row), receipt: JSON.parse(row.receipt) }));
    const latest = submissions.at(-1);
    return { ...run, collections, submissions, snapshot: latest?.payload.snapshot ?? null, taskSnapshot: run.taskSnapshot ?? run.snapshot, result: latest?.payload ?? null, errors: latest?.payload.errors ?? [], receipts: submissions.map(s => s.receipt) };
  }
  list(table, { limit = 50, cursor, q = '', type = '' } = {}) {
    check(Number.isInteger(limit) && limit >= 1 && limit <= 200, 'INVALID_LIMIT', 400);
    const valid = ['tasks','runs','entities','workers']; check(valid.includes(table), 'INVALID_LIST', 400);
    let after = 0;
    if (cursor) { try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()); check(parsed.table === table && Number.isSafeInteger(parsed.seq) && parsed.seq >= 0, 'INVALID_CURSOR', 400); after = parsed.seq; } catch { check(false, 'INVALID_CURSOR', 400); } }
    const params = [after]; let filter = '';
    if (table === 'entities') { filter = ' AND (?=\'\' OR instr(lower(source_key),lower(?))>0) AND (?=\'\' OR entity_type=?)'; params.push(q,q,type,type); }
    const rows = this.db.prepare(`SELECT rowid AS page_seq,doc FROM ${table} WHERE rowid>?${filter} ORDER BY rowid LIMIT ?`).all(...params, limit + 1);
    const items = rows.slice(0, limit).map(row => table === 'entities' ? this.entityMetadata(decode(row)) : decode(row));
    return { items, nextCursor: rows.length > limit ? Buffer.from(encode({ table, seq: rows[limit - 1].page_seq })).toString('base64url') : null };
  }
  getEntity(id, pagination = {}) {
    const entity = decode(this.db.prepare('SELECT doc FROM entities WHERE id=?').get(id)); check(entity, 'ENTITY_NOT_FOUND', 404);
    const limit = pagination.limit ?? 50; check(Number.isInteger(limit) && limit > 0 && limit <= 200, 'INVALID_LIMIT', 400);
    let after = 0;
    if (pagination.cursor) { try { const cursor = JSON.parse(Buffer.from(pagination.cursor, 'base64url').toString()); check(cursor.entityId === id && Number.isSafeInteger(cursor.seq) && cursor.seq >= 0, 'INVALID_CURSOR', 400); after = cursor.seq; } catch { check(false, 'INVALID_CURSOR', 400); } }
    const rows = this.db.prepare('SELECT seq,doc FROM versions WHERE entity_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit + 1);
    return { entity: this.entityView(entity), versions: rows.slice(0,limit).map(row => this.versionView(decode(row))), nextCursor: rows.length > limit ? Buffer.from(encode({ entityId: id, seq: rows[limit-1].seq })).toString('base64url') : null };
  }
}
