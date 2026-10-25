import githubTrending from '../../../plugins/github-trending/index.js';
import { hash, runPlugin, readOpenDraft, sealPluginResult, readSealedSubmission } from '../../../packages/plugin-sdk/index.js';
import { withCdpPage } from '../../../packages/plugin-sdk/cdp-page.js';
import { Cdp, CdpPage } from './cdp.js';
import { DeliverySpool } from './spool.js';

export const registry = new Map([['github-trending@0.1.0', githubTrending]]);
const error = code => Object.assign(new Error(code), { code });
const safeCode = e => /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code ?? e?.message) ? (e.code ?? e.message) : 'WORKER_RUN_FAILED';
const sleep = (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  if (signal?.aborted) done(); else signal?.addEventListener('abort', done, { once: true });
});
export function deadlineFor(config, now = Date.now()) {
  return new Date(now + Math.min(1800000, Math.max(120000, config.maxRepos * (config.itemDelayMs + 30000)))).toISOString();
}
export class WorkerApi {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = new URL(url); this.token = token; this.fetch = fetchImpl;
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password) throw error('INVALID_SERVER_URL');
  }
  async post(path, body, signal) {
    const response = await this.fetch(new URL(`/api/v1/worker/${path}`, this.url), {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!response.ok) throw error(response.status === 413 ? 'SERVER_PAYLOAD_TOO_LARGE' : `SERVER_HTTP_${response.status}`);
    return response.status === 204 ? null : response.json();
  }
}
// 每个任务创建独占 target；关闭失败即使采集成功也必须锁定 controller。
export async function taskPage(use, lease, plugin, assertOpen = () => {}) {
  const check = () => { assertOpen(); if (lease.signal.aborted || Date.now() >= lease.deadline) throw error('CANCELLED'); };
  check(); const cdp = await Cdp.connect(); let page;
  try {
    check(); page = await CdpPage.create(cdp); check();
    return await withCdpPage(page, use, { ...lease, allowedDomains: plugin.manifest.allowedDomains });
  } finally {
    try { if (page) await page.close(); } catch { throw error('TARGET_CLEANUP_FAILED'); }
    finally { cdp.close(); }
  }
}
export class WorkerPoller {
  constructor({ controller, api, workerId = 'worker-main', spoolRoot = '/data/spool', withPage = taskPage,
    plugins = registry, heartbeatMs = 15000, pollMs = 3500 }) {
    Object.assign(this, { controller, api, workerId, withPage, plugins, heartbeatMs, pollMs });
    this.spool = new DeliverySpool(spoolRoot); this.abort = new AbortController(); this.activeRunId = null;
  }
  start() {
    this.loopPromise = this.loop(); this.statusPromise = this.statusLoop();
    return this;
  }
  async stop(timeout = 12000) {
    this.abort.abort();
    let timer;
    try { await Promise.race([Promise.allSettled([this.loopPromise, this.statusPromise]), new Promise(resolve => { timer = setTimeout(resolve, timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async statusLoop() {
    while (!this.abort.signal.aborted) {
      try { await this.api.post('status', { workerId: this.workerId, ...this.status() }, this.abort.signal); } catch { /* 下轮再报，不接管页面。 */ }
      await sleep(this.heartbeatMs, this.abort.signal);
    }
  }
  status() { const { mode, busy } = this.controller.status(); return { mode, busy, activeRunId: this.activeRunId }; }
  async loop() {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try { await this.tick(); failures = 0; } catch { failures = Math.min(5, failures + 1); }
      await sleep(Math.min(60000, this.pollMs * 2 ** failures), this.abort.signal);
    }
  }
  async tick() {
    const status = this.controller.status();
    if (this.abort.signal.aborted || status.busy || status.faulted || status.mode.startsWith('MANUAL')) return;
    return this.controller.runExternal(async () => {
      // 领取结果尚未落盘时先找回原ticket，绝不换key领取其他run。
      const ticket = await this.spool.loadClaimTicket();
      if (ticket) return this.claimTicket(ticket);
      // 先扫描恢复；任何未确认记录都会阻止领取新任务。
      const pending = await this.spool.pending();
      if (pending.length) {
        const priority = new Map();
        for (const record of pending) {
          const document = record.collection && await this.spool.store.load(record.run.id, record.collection.collectionId);
          priority.set(record, document?.phase === 'SEALED' ? 0 : 1);
        }
        pending.sort((a, b) => priority.get(a) - priority.get(b));
        for (const record of pending) {
          this.checkStopping();
          await this.recoverRecord(record);
        }
        return;
      }
      this.checkStopping();
      return this.claimTicket(await this.spool.createClaimTicket(this.workerId));
    });
  }
  async recoverRecord(record) {
    this.activeRunId = record.run.id;
    try {
      await this.api.post('status',{ workerId:this.workerId,...this.status() },this.abort.signal);
      return await this.recover(record);
    } finally { this.activeRunId = null; }
  }
  newRecord(run,lease) {
    return { run: { id:run.id,taskId:run.taskId,pluginId:run.pluginId,pluginVersion:run.pluginVersion,profileId:run.profileId,config:run.config,taskSnapshotRef:run.taskSnapshotRef,...(run.deadline ? { deadline:run.deadline } : {}) },
      lease:{ ...lease },collection:null,registrationKey:`${run.id}-initial`,delivered:false,status:'FAILED' };
  }
  async claimTicket(ticket) {
    if (ticket.workerId !== this.workerId) throw error('CLAIM_WORKER_MISMATCH');
    const claimed = await this.api.post('claims',ticket,this.abort.signal);
    if (!claimed) { await this.spool.clearClaimTicket(); return; }
    let record = await this.spool.store.load(claimed.run.id,'pending-delivery'); const existing = !!record;
    if (!record) {
      record = this.newRecord(claimed.run,claimed.lease); record.claimRequestKey = ticket.requestKey;
      await this.spool.save(record);
    }
    // record的原子落盘完成后才清ticket；清理失败的重试也只能恢复此record。
    await this.spool.clearClaimTicket();
    if (record.delivered) return;
    if (existing || claimed.action === 'finalize_only' || claimed.run.status !== 'RUNNING' && claimed.run.status !== undefined || claimed.run.cancelRequested || Date.parse(claimed.lease.leaseUntil) <= Date.now()+5000) return this.recoverRecord(record);
    return this.execute(claimed.run,claimed.lease,record);
  }
  checkStopping() { if (this.abort.signal.aborted) throw error('WORKER_STOPPING'); }
  auth(record) { return { workerId: this.workerId, attempt: record.lease.attempt, fencingToken: record.lease.fencingToken }; }
  path(record, suffix) { return `runs/${encodeURIComponent(record.run.id)}/${suffix}`; }
  plugin(record) {
    const plugin = this.plugins.get(`${record.run.pluginId}@${record.run.pluginVersion}`);
    if (!plugin || record.run.profileId !== 'main') throw error('UNSUPPORTED_TASK');
    return plugin;
  }
  options(record) {
    return { runId: record.run.id, ...record.collection, config: record.run.config, deadline: record.deadline, store: this.spool.store };
  }
  async progressFor(record) {
    const progress = { ...(record.progress ?? { phase:'COLLECT' }) };
    if (!record.collection) return progress;
    const document = await this.spool.store.load(record.run.id,record.collection.collectionId);
    let keys,processed;
    if (document?.phase === 'OPEN' && Array.isArray(document.state?.queue)) {
      keys = new Set(document.state.queue.map(item => item.key));
      processed = new Set([...(document.state.items ?? []).map(item => item.queueKey),...(document.state.terminalItemFailures ?? [])]);
    } else if (document?.phase === 'SEALED' && Array.isArray(document.submission?.payload.snapshot?.entries)) {
      const entries = document.submission.payload.snapshot.entries;
      keys = new Set(entries.map(item => item.key)); processed = new Set(entries.filter(item => ['completed','failed'].includes(item.status)).map(item => item.key));
      progress.phase = 'UPLOAD';
    }
    if (keys) { progress.total = keys.size; progress.completed = [...processed].filter(key => keys.has(key)).length; }
    record.progress = progress; return progress;
  }
  resultSummary(payload) {
    const entries = payload.snapshot?.entries ?? [];
    return { completeness:payload.completeness,items:payload.items?.length ?? 0,succeeded:payload.items?.length ?? 0,
      failed:new Set(payload.terminalItemFailures ?? []).size,completed:new Set(entries.filter(item => ['completed','failed'].includes(item.status)).map(item => item.key)).size,total:entries.length };
  }
  async outcome(record) {
    const progress = await this.progressFor(record);
    if (!record.outcomeIntent) {
      record.outcomeIntent = { status:record.status,errorCode:record.errorCode ?? null,summary:structuredClone(record.summary ?? {}) };
      await this.spool.save(record); // 发送前固定意图，网络响应丢失不改变错误或统计。
    }
    await this.api.post(this.path(record,'outcome'),{ ...this.auth(record),...record.outcomeIntent,progress },this.abort.signal);
    record.delivered = true; await this.spool.save(record);
  }
  async terminalOutcome(record,response) {
    const saved = response.outcome ?? response.run?.outcome;
    if (saved) {
      if (record.outcomeIntent && hash(record.outcomeIntent) !== hash(saved)) throw error('OUTCOME_INTENT_CONFLICT');
      record.outcomeIntent ??= structuredClone(saved);
      await this.spool.save(record); await this.outcome(record);
    } else { record.delivered = true; record.terminalStatus = response.run?.status; await this.spool.save(record); }
  }
  async deliver(record, submission, guard = () => {}) {
    guard();
    await this.api.post(this.path(record, `collections/${encodeURIComponent(submission.collectionId)}/seal`), { ...this.auth(record), submission }, this.abort.signal);
    guard();
    const response = await this.api.post(this.path(record, 'submissions'), { ...this.auth(record), submission }, this.abort.signal);
    if (!this.confirmedReceipt(response?.receipt, submission)) throw error('ARCHIVE_CONFIRMATION_REQUIRED');
    record.receipt = response.receipt; await this.spool.save(record);
    guard(); await this.outcome(record);
  }
  confirmedReceipt(receipt, submission) {
    return receipt?.submissionId === submission.submissionId && receipt.collectionId === submission.collectionId &&
      receipt.collectionSeq === submission.collectionSeq && typeof receipt.archived === 'boolean' &&
      ['applied', 'stale', 'APPLIED', 'STALE'].includes(receipt.disposition);
  }
  async execute(run, lease, record = this.newRecord(run,lease)) {
    await this.spool.save(record);
    return this.withLease(record, async (signal, guard, cancelled) => {
      const plugin = this.plugin(record); record.run.config = plugin.validateConfig(run.config);
      record.deadline = deadlineFor(record.run.config);
      if (run.deadline) {
        const limit = Date.parse(run.deadline);
        if (!Number.isFinite(limit)) throw error('INVALID_DEADLINE');
        record.deadline = new Date(Math.min(limit, Date.parse(record.deadline))).toISOString();
      }
      guard();
      record.collection = await this.api.post(this.path(record, 'collections'), { ...this.auth(record), registrationKey: record.registrationKey }, signal);
      if (record.run.taskSnapshotRef !== record.collection.taskSnapshotRef) throw error('TASK_SNAPSHOT_MISMATCH');
      await this.spool.save(record);
      let draft; let cleanupError;
      try {
        draft = await runPlugin(plugin, { ...this.options(record), signal,
          withPage: (use, pageLease) => this.withPage(use, pageLease, plugin, () => { this.checkStopping(); guard(); }),
          progress: p => { record.progress = { phase: 'COLLECT', itemKey: p.itemKey }; } });
      } catch (e) {
        if (safeCode(e) === 'TARGET_CLEANUP_FAILED') cleanupError = e;
        record.errorCode = safeCode(e);
        try { draft = await readOpenDraft(plugin, this.options(record)); } catch (readError) {
          if (cleanupError) throw cleanupError;
          if (readError.code !== 'CHECKPOINT_NOT_FOUND') throw readError;
        }
      }
      record.status = cancelled() ? 'CANCELLED' : draft ? (draft.completeness === 'complete' ? 'SUCCEEDED' : 'PARTIAL') : 'FAILED';
      if (draft) {
        await this.spool.save(record);
        // 即使中心断连也先保存 SEALED；失效租约不再上传新载荷。
        const submission = await sealPluginResult(plugin, this.options(record), draft);
        record.submission = { submissionId: submission.submissionId, payloadHash: submission.payloadHash };
        record.summary = this.resultSummary(submission.payload);
        await this.spool.save(record);
        if (cleanupError) throw cleanupError;
        guard(); await this.deliver(record, submission, guard);
      } else {
        await this.spool.save(record);
        if (cleanupError) throw cleanupError;
        guard(); await this.outcome(record);
      }
    });
  }
  async withLease(record, action) {
    this.activeRunId = record.run.id;
    const local = new AbortController(); const timerAbort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, local.signal]);
    let cancelled = record.status === 'CANCELLED'; let lost = false; let failures = 0; let expiry;
    const arm = () => {
      clearTimeout(expiry);
      const remaining = Date.parse(record.lease.leaseUntil) - Date.now() - 5000;
      if (!Number.isFinite(remaining) || remaining <= 0) { lost = true; local.abort(); return; }
      expiry = setTimeout(() => { lost = true; local.abort(); }, Math.min(remaining, 2147483647));
    };
    const guard = () => { this.checkStopping(); if (lost || Date.now() >= Date.parse(record.lease.leaseUntil) - 5000) throw error('LEASE_LOST'); };
    arm();
    const heartbeats = (async () => {
      while (!timerAbort.signal.aborted && !this.abort.signal.aborted && !lost) {
        await sleep(this.heartbeatMs, AbortSignal.any([timerAbort.signal, this.abort.signal]));
        if (timerAbort.signal.aborted || this.abort.signal.aborted || lost) break;
        try {
          const reply = await this.api.post(this.path(record, 'heartbeat'), { ...this.auth(record), progress: await this.progressFor(record) }, this.abort.signal);
          if (timerAbort.signal.aborted || lost) break;
          record.lease.leaseUntil = reply.leaseUntil; failures = 0; arm();
          if (reply.cancelRequested) { cancelled = true; record.status = 'CANCELLED'; local.abort(); }
        } catch { if (++failures >= 2) { lost = true; local.abort(); } }
      }
    })();
    try { guard(); return await action(signal, guard, () => cancelled); }
    catch (e) {
      if (['UNSUPPORTED_TASK', 'INVALID_CONFIG', 'INVALID_DEADLINE', 'TASK_SNAPSHOT_MISMATCH'].includes(safeCode(e))) {
        record.status = cancelled ? 'CANCELLED' : 'FAILED'; record.errorCode = safeCode(e);
        await this.spool.save(record); guard(); await this.outcome(record);
      } else throw e;
    }
    finally { timerAbort.abort(); clearTimeout(expiry); await heartbeats; this.activeRunId = null; }
  }
  async recover(record) {
    let submission;
    if (record.collection) {
      const document = await this.spool.store.load(record.run.id, record.collection.collectionId);
      if (document?.phase === 'SEALED') submission = await readSealedSubmission(this.plugin(record), this.options(record));
    }
    if (!submission) {
      const response = await this.api.post(this.path(record,'recover-finalization'),{ workerId:this.workerId,stopped:true },this.abort.signal);
      if (response.action === 'terminal') return this.terminalOutcome(record,response);
      if (response.action !== 'finalize_only' || !response.lease) throw error('FINALIZATION_RECOVERY_BLOCKED');
      record.lease = response.lease;
      if (!record.outcomeIntent) {
        record.status = response.run?.cancelRequested ? 'CANCELLED' : 'FAILED';
        record.errorCode ??= 'OPEN_RESUME_REQUIRES_AUTHORIZATION';
      }
      await this.spool.save(record);
      return this.withLease(record,async (_signal,guard) => { guard(); await this.outcome(record); });
    }
    if (!record.outcomeIntent && !record.submission && record.status !== 'CANCELLED') record.status = submission.payload.completeness === 'complete' ? 'SUCCEEDED' : 'PARTIAL';
    record.submission = { submissionId: submission.submissionId, payloadHash: submission.payloadHash };
    record.summary ??= this.resultSummary(submission.payload);
    const response = await this.api.post(this.path(record, 'recover'), { workerId: this.workerId,
      collectionId: submission.collectionId, submissionId: submission.submissionId, payloadHash: submission.payloadHash }, this.abort.signal);
    const action = response.action ?? response.decision;
    if (response.run?.cancelRequested && !record.outcomeIntent) record.status = 'CANCELLED';
    if (action === 'terminal') return this.terminalOutcome(record,response);
    if (action === 'blocked') throw error('RECOVERY_BLOCKED');
    if (action === 'replay_receipt' || action === 'stale' && response.receipt) {
      if (!this.confirmedReceipt(response.receipt, submission)) throw error('ARCHIVE_CONFIRMATION_REQUIRED');
      record.receipt = response.receipt;
      if (response.lease) record.lease = response.lease;
      await this.spool.save(record);
      if (response.run?.outcome || response.outcome) return this.terminalOutcome(record,response);
      // 收据不等于终态确认；需要中心续发的上传/终结授权。
      await this.outcome(record);
      return;
    }
    if (!['authorize_upload', 'stale'].includes(action) || !response.lease) throw error('INVALID_RECOVERY_RESPONSE');
    record.lease = response.lease;
    await this.spool.save(record);
    await this.withLease(record, async (_signal, guard) => this.deliver(record, submission, guard));
  }
}
