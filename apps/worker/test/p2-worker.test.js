import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Controller } from '../src/controller.js';
import { WorkerApi, WorkerPoller, deadlineFor } from '../src/poller.js';

const run = { id: 'run-1', taskId: 'task-1', pluginId: 'fixture', pluginVersion: '0.1.0', profileId: 'main', config: { maxRepos: 1, itemDelayMs: 3000 }, taskSnapshotRef: 'snapshot-1' };
const lease = () => ({ attempt: 1, fencingToken: 'fence-1', leaseUntil: new Date(Date.now() + 90000).toISOString() });
const snapshotResult = (ctx, state) => ({ collectionId: ctx.collectionId, collectionSeq: ctx.collectionSeq,
  completeness: state.complete ? 'complete' : 'partial', items: state.items, snapshot: { entries: [] } });
const plugin = { manifest: { id: 'fixture', version: '0.1.0', engineApiVersion: '1', allowedDomains: ['fixture.invalid'] },
  validateConfig: x => x, validateState: x => Array.isArray(x.items), snapshotResult,
  collect: async ctx => ctx.withPage(async page => {
    await ctx.commit({ items: [{ key: 'first' }], complete: false });
    await page.navigate();
    await ctx.commit({ items: [{ key: 'first' }], complete: true });
    return snapshotResult(ctx, ctx.checkpoint.state);
  }) };
class FakeApi {
  calls = []; failSubmission = false; failSeal = false; cancel = false;
  async post(path, body) {
    this.calls.push({ path, body: structuredClone(body) });
    if (path === 'claims') return { run, lease: lease() };
    if (path.endsWith('/collections')) return { collectionId: 'collection-1', collectionSeq: 1, taskSnapshotRef: run.taskSnapshotRef };
    if (path.endsWith('/heartbeat')) return { cancelRequested: this.cancel, leaseUntil: lease().leaseUntil };
    if (path.endsWith('/seal') && this.failSeal) throw new Error('SERVER_PAYLOAD_TOO_LARGE');
    if (path.endsWith('/submissions')) {
      this.submission = body.submission;
      if (this.failSubmission) throw new Error('SERVER_HTTP_503');
      return { receipt: this.receipt(body.submission.submissionId) };
    }
    if (path.endsWith('/recover-finalization')) return this.finalization ?? { action:'finalize_only',lease:lease() };
    if (path.endsWith('/recover')) return this.recovery ?? { action: 'authorize_upload', lease: lease() };
    return {};
  }
  receipt(submissionId) { return { submissionId, collectionId: 'collection-1', collectionSeq: 1, archived: false, disposition: 'applied' }; }
}
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'worker-p2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new Controller({ desktop: { start: async () => {}, stop: async () => {} }, execute: async () => {} });
  const api = new FakeApi(); let pages = 0;
  const args = { controller, api, spoolRoot: root, plugins: new Map([['fixture@0.1.0', plugin]]),
    withPage: async use => { pages++; return use({ navigate: async () => {} }); }, ...options };
  return { root, controller, api, args, poller: new WorkerPoller(args), pages: () => pages };
}
test('P2 全链使用同一 collection，先本地 SEALED 再中心 CAS，再提交/终态', async t => {
  const x = await setup(t);
  x.api.post = new Proxy(x.api.post, { apply: async (target, receiver, args) => {
    if (args[0].endsWith('/seal')) {
      const document = JSON.parse(await readFile(join(x.root, run.id, 'collection-1.json'), 'utf8'));
      assert.equal(document.phase, 'SEALED');
      assert.equal(document.submission.payloadHash, args[1].submission.payloadHash);
    }
    return Reflect.apply(target, receiver, args);
  } });
  await x.poller.tick();
  assert.deepEqual(x.api.calls.map(c => c.path), ['claims', 'runs/run-1/collections', 'runs/run-1/collections/collection-1/seal', 'runs/run-1/submissions', 'runs/run-1/outcome']);
  assert.equal(x.api.calls.at(-1).body.status, 'SUCCEEDED');
  assert.equal(x.pages(), 1); assert.equal((await x.poller.spool.pending()).length, 0);
});
test('MANUAL 不 claim；外部任务持 busy，manual-start 返回 WORKER_BUSY，status 可读', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const x = await setup(t, { withPage: async use => { await gate; return use({ navigate: async () => {} }); } });
  await x.controller.run({ command: 'manual-start' }); await x.poller.tick(); assert.equal(x.api.calls.length, 0);
  await x.controller.run({ command: 'manual-finish' });
  const pending = x.poller.tick();
  while (!x.controller.busy || !x.api.calls.some(c => c.path.endsWith('/collections'))) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(x.controller.run({ command: 'manual-start' }), /WORKER_BUSY/);
  assert.equal((await x.controller.run({ command: 'status' })).busy, true);
  release(); await pending;
});
test('提交响应丢失，重启只 recover 原 SEALED，不再抓网页/claim', async t => {
  const x = await setup(t); x.api.failSubmission = true;
  await assert.rejects(x.poller.tick(), /SERVER_HTTP_503/);
  const original = x.api.submission;
  x.api.failSubmission = false;
  const restarted = new WorkerPoller({ ...x.args, withPage: () => assert.fail('恢复不可访问页面') });
  x.api.calls = []; await restarted.tick();
  assert.equal(x.api.calls[1].path, 'runs/run-1/recover');
  assert.deepEqual(x.api.submission, original);
  assert.equal(x.api.calls.some(c => c.path === 'claims'), false);
  assert.equal((await restarted.spool.pending()).length, 0);
  assert.equal(JSON.parse(await readFile(join(x.root, run.id, 'collection-1.json'))).phase, 'SEALED');
});
test('replay_receipt 只确认原收据；不重传网页/载荷', async t => {
  const x = await setup(t); x.api.failSubmission = true;
  await assert.rejects(x.poller.tick());
  x.api.recovery = { action: 'replay_receipt', receipt: x.api.receipt(x.api.submission.submissionId), lease: lease() };
  x.api.calls = []; await x.poller.tick();
  assert.deepEqual(x.api.calls.map(c => c.path), ['status', 'runs/run-1/recover', 'runs/run-1/outcome']);
});
test('413/blocked 保留 spool，不重新 claim；轮询退避由 loop 负责', async t => {
  const x = await setup(t); x.api.failSeal = true;
  await assert.rejects(x.poller.tick());
  x.api.recovery = { action: 'blocked' }; x.api.calls = [];
  await assert.rejects(x.poller.tick(), /RECOVERY_BLOCKED/);
  assert.equal((await x.poller.spool.pending()).length, 1);
  assert.equal(x.pages(), 1); assert.equal(x.api.calls.some(c => c.path === 'claims'), false);
});
test('取消封存已保存 partial，提交后必须 CANCELLED', async t => {
  let navigating = false;
  const x = await setup(t, { heartbeatMs: 5, withPage: async (use, pageLease) => use({ navigate: () => new Promise((resolve, reject) => {
    navigating = true;
    const abort = () => reject(new Error('CANCELLED'));
    if (pageLease.signal.aborted) abort(); else pageLease.signal.addEventListener('abort', abort, { once: true });
  }) }) });
  const post = x.api.post.bind(x.api);
  x.api.post = (path, body) => {
    if (path.endsWith('/heartbeat')) x.api.cancel = navigating;
    return post(path, body);
  };
  await x.poller.tick();
  assert.ok(x.api.submission,JSON.stringify(x.api.calls.filter(c => c.path.endsWith('/outcome')).map(c => ({ status:c.body.status,errorCode:c.body.errorCode }))));
  assert.equal(x.api.submission.payload.completeness, 'partial');
  assert.equal(x.api.calls.findLast(c => c.path.endsWith('/outcome')).body.status, 'CANCELLED');
});
test('连续心跳失败 abort，租约失效不上传新 payload，重启恢复 SEALED', async t => {
  let navigating = false;
  const x = await setup(t, { heartbeatMs: 5, withPage: async (use, pageLease) => use({ navigate: () => new Promise((resolve, reject) => {
    navigating = true;
    pageLease.signal.addEventListener('abort', () => reject(new Error('CANCELLED')), { once: true });
  }) }) });
  const post = x.api.post.bind(x.api);
  x.api.post = (path, body) => { if (path.endsWith('/heartbeat') && navigating) throw new Error('SERVER_HTTP_503'); return post(path, body); };
  let caught;
  try { await x.poller.tick(); } catch (e) { caught = e; }
  assert.equal(caught?.message,'LEASE_LOST',JSON.stringify(x.api.calls.filter(c => c.path.endsWith('/outcome')).map(c => ({ status:c.body.status,errorCode:c.body.errorCode }))));
  assert.equal(x.api.calls.some(c => c.path.endsWith('/seal')), false);
  assert.equal(JSON.parse(await readFile(join(x.root, run.id, 'collection-1.json'))).phase, 'SEALED');
});
test('成功路径 page.close 失败也锁定 controller', async t => {
  const x = await setup(t, { withPage: async use => { await use({ navigate: async () => {} }); throw new Error('TARGET_CLEANUP_FAILED'); } });
  await assert.rejects(x.poller.tick(), /TARGET_CLEANUP_FAILED/);
  assert.equal(x.controller.faulted, true);
  await assert.rejects(x.controller.run({ command: 'manual-start' }), /WORKER_RESTART_REQUIRED/);
});
test('OPEN 重启报告待处理且不授权续采', async t => {
  const x = await setup(t);
  await x.poller.spool.save({ run, lease: lease(), collection: null, registrationKey: 'run-1-initial', delivered: false });
  await x.poller.tick();
  assert.equal(x.api.calls.at(-1).body.errorCode, 'OPEN_RESUME_REQUIRES_AUTHORIZATION');
  assert.equal(x.pages(), 0); assert.equal(x.api.calls.some(c => c.path === 'claims'), false);
});
test('shutdown abort 页面且不再 claim/spawn', async t => {
  const x = await setup(t, { withPage: async (use, pageLease) => use({ navigate: () => new Promise((resolve, reject) => {
    pageLease.signal.addEventListener('abort', () => reject(new Error('CANCELLED')), { once: true });
  }) }) });
  const pending = x.poller.tick();
  while (!x.api.calls.some(c => c.path.endsWith('/collections'))) await new Promise(resolve => setImmediate(resolve));
  await x.poller.stop();
  await assert.rejects(pending, /WORKER_STOPPING/);
  const count = x.api.calls.length; await x.poller.tick(); assert.equal(x.api.calls.length, count);
});
test('spool 不扫描 symlink run 目录', async t => {
  const x = await setup(t); const outside = await mkdtemp(join(tmpdir(), 'worker-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  try { await symlink(outside, join(x.root, 'linked-run'), 'junction'); }
  catch (e) { if (e.code === 'EPERM') return t.skip('系统禁止 symlink'); throw e; }
  assert.deepEqual(await x.poller.spool.pending(), []);
});
test('deadline 最少120s、最多30m', () => {
  assert.equal(Date.parse(deadlineFor({ maxRepos: 1, itemDelayMs: 3000 }, 0)), 120000);
  assert.equal(Date.parse(deadlineFor({ maxRepos: 100, itemDelayMs: 3600000 }, 0)), 1800000);
});
test('stale 授权只上传原包并保留 SDK SEALED', async t => {
  const x = await setup(t); x.api.failSeal = true;
  await assert.rejects(x.poller.tick(), /SERVER_PAYLOAD_TOO_LARGE/);
  const original = JSON.parse(await readFile(join(x.root, run.id, 'collection-1.json'))).submission;
  x.api.failSeal = false; x.api.recovery = { action: 'stale', lease: lease() };
  x.api.calls = []; await x.poller.tick();
  assert.deepEqual(x.api.submission, original); assert.equal(x.pages(), 1);
});
test('replay 后 outcome 未确认则保留 pending，重试不提交新载荷', async t => {
  const x = await setup(t); x.api.failSubmission = true;
  await assert.rejects(x.poller.tick());
  x.api.recovery = { action: 'replay_receipt', receipt: x.api.receipt(x.api.submission.submissionId) };
  const post = x.api.post.bind(x.api);
  x.api.post = (path, body) => { if (path.endsWith('/outcome')) throw new Error('SERVER_HTTP_409'); return post(path, body); };
  await assert.rejects(x.poller.tick(), /SERVER_HTTP_409/);
  assert.equal((await x.poller.spool.pending()).length, 1);
  x.api.post = post; x.api.calls = []; await x.poller.tick();
  assert.equal((await x.poller.spool.pending()).length, 0);
  assert.equal(x.api.calls.some(c => c.path.endsWith('/submissions')), false);
});
test('无草稿取消仅上报 CANCELLED，不生成空提交', async t => {
  const x = await setup(t, { heartbeatMs: 5 });
  const noDraft = { ...plugin, collect: ctx => new Promise((resolve, reject) => {
    const abort = () => reject(new Error('CANCELLED'));
    if (ctx.signal.aborted) abort(); else ctx.signal.addEventListener('abort', abort, { once: true });
  }) };
  x.poller.plugins = new Map([['fixture@0.1.0', noDraft]]); x.api.cancel = true;
  await x.poller.tick();
  assert.equal(x.api.calls.findLast(c => c.path.endsWith('/outcome')).body.status, 'CANCELLED');
  assert.equal(x.api.calls.some(c => c.path.endsWith('/submissions')), false);
});
test('恢复时 SEALED 排在 OPEN 待处理记录之前', async t => {
  const x = await setup(t); x.api.failSeal = true; await assert.rejects(x.poller.tick());
  await x.poller.spool.save({ run: { ...run, id: 'a-open-run' }, lease: lease(), collection: null, delivered: false });
  x.api.failSeal = false; x.api.calls = []; await x.poller.tick();
  const paths = x.api.calls.map(c => c.path);
  assert.ok(paths.indexOf('runs/run-1/recover') < paths.indexOf('runs/a-open-run/outcome'));
  assert.equal(x.api.calls.some(c => c.path === 'claims'), false);
});
test('心跳读取与SDK原子写共享队列，只在提交后读取新检查点',async t => {
  const x = await setup(t); const store = x.poller.spool.store;
  await store.save(run.id,'serialization',{ generation:1 });
  let entered,release;
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const releaseGate = new Promise(resolve => { release = resolve; });
  store.beforeRename = async () => { entered(); await releaseGate; };
  const writing = store.save(run.id,'serialization',{ generation:2 }); await enteredGate;
  let readDone = false; const reading = store.load(run.id,'serialization').then(value => { readDone = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(readDone,false);
  release(); await writing; assert.deepEqual(await reading,{ generation:2 });
});

test('Node 原生 fetch 对接假 HTTP API，Bearer/204/413', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(text) });
    res.writeHead(req.url.endsWith('claims') ? 204 : 413); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = new WorkerApi({ url: `http://127.0.0.1:${server.address().port}`, token: 'fixture-secret' });
  assert.equal(await api.post('claims', { workerId: 'worker-main' }), null);
  await assert.rejects(api.post('status', {}), /SERVER_PAYLOAD_TOO_LARGE/);
  assert.deepEqual(requests[0], { url: '/api/v1/worker/claims', auth: 'Bearer fixture-secret', body: { workerId: 'worker-main' } });
});
