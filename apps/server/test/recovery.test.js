import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { Auth } from '../auth.js';
import { createServer } from '../server.js';
import { WorkerApi,WorkerPoller } from '../../worker/src/poller.js';
import { start,register,submission,ingest,workerId,credentials } from './helpers.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'server-recovery-')); const filename = join(root,'test.sqlite');
  const [password,workerToken] = [randomBytes(32).toString('base64url'),randomBytes(32).toString('base64url')];
  let now = Date.now(); let store,server; const requests = []; let drop;
  const context = { root,requests,get store() { return store; },get now() { return now; },advance(ms) { now += ms; },dropOnce(path) { drop = path; } };
  const api = new WorkerApi({ url:'http://127.0.0.1',token:workerToken,fetchImpl:async (url,options) => {
    const path = new URL(url).pathname; requests.push({ path,body:JSON.parse(options.body) });
    const response = await fetch(url,options);
    if (path.endsWith(drop ?? 'NO_DROP')) {
      drop = undefined; await response.arrayBuffer();
      // 真实HTTP已经返回，server事务已提交；模拟worker未收到响应。
      throw Object.assign(new Error('TEST_COMMITTED_RESPONSE_LOST'),{ code:'TEST_COMMITTED_RESPONSE_LOST' });
    }
    return response;
  } });
  async function openServer() {
    store = new Store({ filename,now:() => now });
    server = createServer({ store,auth:new Auth({ password,workerToken,publicOrigin:'http://127.0.0.1:18080',secureCookie:false }) });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    api.url = new URL(`http://127.0.0.1:${server.address().port}`);
  }
  async function closeServer() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
  await openServer(); context.restart = async () => { await closeServer(); await openServer(); };
  t.after(async () => { await closeServer(); rmSync(root,{ recursive:true,force:true }); });
  const controller = { busy:false,status() { return { mode:'PAUSED',busy:this.busy,faulted:false }; },async runExternal(action) { assert.equal(this.busy,false); this.busy = true; try { return await action(); } finally { this.busy = false; } } };
  context.poller = (withPage = () => assert.fail('恢复禁止访问页面'),extra = {}) => new WorkerPoller({ controller,api,spoolRoot:join(root,'spool'),withPage,...extra });
  context.api = api;
  const task = store.list('tasks').items[0]; store.patchTask(task.id,{ config:{ maxRepos:1,itemDelayMs:3000 } });
  context.taskId = task.id; return context;
}
function pageForOne(onNavigate = () => {}) {
  let navigation = 0;
  return async use => use({
    async navigate() { onNavigate(); navigation++; return { status:200 }; },
    async evaluateRead() { return navigation === 1 ? { url:'https://github.com/trending?since=daily',listPresent:true,rows:[{ href:'https://github.com/example/repo' }] } : { url:'https://github.com/example/repo',repoPresent:true,readmePresent:true,text:'恢复协议真实SDK正文',pageHref:'https://github.com/example/repo#readme-ov-file' }; }
  });
}

test('P1 claims已提交响应丢失：ticket优先、中心重启及租约过期仍取回同run，仅终结不抓页面',async t => {
  const f = await fixture(t); const first = f.store.createRun(f.taskId,'claim-first'); const next = f.store.createRun(f.taskId,'claim-next');
  const original = f.poller(); f.dropOnce('/claims');
  await assert.rejects(original.tick(),e => e.code === 'TEST_COMMITTED_RESPONSE_LOST');
  const ticket = await original.spool.loadClaimTicket(); assert.ok(ticket?.requestKey);
  assert.equal((await original.spool.pending()).length,0); assert.equal(f.store.run(first.id).status,'RUNNING');
  assert.equal(f.store.db.prepare('SELECT holder FROM profiles').get().holder,first.id);
  f.advance(90001); await f.restart();
  const restarted = f.poller(); await restarted.tick();
  assert.equal(await restarted.spool.loadClaimTicket(),null); assert.equal((await restarted.spool.pending()).length,0);
  assert.equal(f.store.run(first.id).status,'FAILED'); assert.equal(f.store.run(next.id).status,'QUEUED');
  assert.equal(f.store.db.prepare('SELECT holder FROM profiles').get().holder,null);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM collections').get().n,0);
  const claims = f.requests.filter(request => request.path.endsWith('/claims'));
  assert.equal(claims.length,2); assert.equal(claims[0].body.requestKey,claims[1].body.requestKey);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n,1);
  assert.equal(f.requests.filter(request => request.path.endsWith('/recover-finalization')).length,1);
});

test('claim ticket仅在pending落盘后清理；清票失败重试原run，不执行网页或领第二个run',async t => {
  const f = await fixture(t); const run = f.store.createRun(f.taskId,'ticket-clear-first'); const next = f.store.createRun(f.taskId,'ticket-clear-next');
  const original = f.poller();
  original.spool.clearClaimTicket = async () => {
    assert.equal((await original.spool.pending())[0].run.id,run.id);
    throw new Error('TEST_TICKET_CLEAR_INTERRUPTED');
  };
  await assert.rejects(original.tick(),/TEST_TICKET_CLEAR_INTERRUPTED/); const ticket = await original.spool.loadClaimTicket(); assert.ok(ticket);
  const restarted = f.poller(); await restarted.tick();
  assert.equal(await restarted.spool.loadClaimTicket(),null); assert.equal((await restarted.spool.pending()).length,0);
  assert.equal(f.store.run(run.id).status,'FAILED'); assert.equal(f.store.run(next.id).status,'QUEUED');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM collections').get().n,0);
  const claims = f.requests.filter(request => request.path.endsWith('/claims')); assert.equal(claims.length,2);
  assert.equal(claims[0].body.requestKey,claims[1].body.requestKey);
});

test('P1 OPEN检查点过期并取消：新finalization lease收尾，保留检查点，绝不续采',async t => {
  const f = await fixture(t); const run = f.store.createRun(f.taskId,'open-cancel'); let pages = 0;
  const original = f.poller(pageForOne(() => { pages++; }));
  const save = original.spool.store.save.bind(original.spool.store);
  original.spool.store.save = async (runId,collectionId,document) => {
    if (document?.phase === 'SEALED') throw new Error('TEST_CRASH_BEFORE_LOCAL_SEAL');
    return save(runId,collectionId,document);
  };
  await assert.rejects(original.tick(),/TEST_CRASH_BEFORE_LOCAL_SEAL/);
  const pending = (await original.spool.pending())[0]; assert.equal((await original.spool.store.load(run.id,pending.collection.collectionId)).phase,'OPEN');
  f.advance(90001); f.store.cancel(run.id); await f.restart();
  const restarted = f.poller(); await restarted.tick();
  const result = f.store.run(run.id); assert.equal(result.status,'CANCELLED');
  assert.equal(result.outcome.status,'CANCELLED'); assert.equal((await restarted.spool.pending()).length,0);
  assert.equal(f.store.db.prepare('SELECT holder FROM profiles').get().holder,null);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,0);
  assert.equal((await restarted.spool.store.load(run.id,pending.collection.collectionId)).phase,'OPEN'); assert.equal(pages,2);
  const lease = { workerId,attempt:result.attempt,fencingToken:result.fencingToken };
  assert.throws(() => f.store.register(run.id,{ ...lease,registrationKey:'no-new-collection' }),e => ['LEASE_INVALID','RUN_TERMINAL'].includes(e.code));
});

for (const sealed of [false,true]) test(`P1 ${sealed ? 'SEALED成功' : 'FAILED无草稿'}outcome已提交响应丢失：持久不可变intent精确重放`,async t => {
  const f = await fixture(t); const run = f.store.createRun(f.taskId,randomUUID()); let navigations = 0;
  const withPage = sealed ? pageForOne(() => { navigations++; }) : async () => { navigations++; throw Object.assign(new Error('READ_TIMEOUT'),{ code:'READ_TIMEOUT' }); };
  const original = f.poller(withPage); f.dropOnce('/outcome');
  await assert.rejects(original.tick(),e => e.code === 'TEST_COMMITTED_RESPONSE_LOST');
  const pending = (await original.spool.pending())[0]; const intent = structuredClone(pending.outcomeIntent);
  assert.deepEqual(f.store.run(run.id).outcome,intent); assert.equal(f.store.run(run.id).status,sealed ? 'SUCCEEDED' : 'FAILED');
  if (!sealed) assert.equal(intent.errorCode,'READ_TIMEOUT');
  await assert.rejects(original.spool.save({ ...pending,outcomeIntent:{ ...intent,errorCode:'DIFFERENT_ERROR' } }),/OUTCOME_INTENT_IMMUTABLE/);
  f.advance(90001); await f.restart();
  const restarted = f.poller(); await restarted.tick();
  assert.equal((await restarted.spool.pending()).length,0); assert.deepEqual(f.store.run(run.id).outcome,intent);
  const outcomes = f.requests.filter(request => request.path.endsWith('/outcome'));
  assert.equal(outcomes.length,2);
  for (const request of outcomes) assert.deepEqual({ status:request.body.status,errorCode:request.body.errorCode,summary:request.body.summary },intent);
  assert.equal(navigations,sealed ? 2 : 1); assert.equal(f.requests.filter(request => request.path.endsWith('/claims')).length,1);
  assert.equal(f.store.db.prepare('SELECT holder FROM profiles').get().holder,null);
});

test('finalization仅原worker确认停止且本地status持锁时授权，fence失效，不能seal/提交/登记',async t => {
  const f = await fixture(t); const claim = start(f.store); const c = register(f.store,claim); const s = submission(claim.run,c);
  const path = `runs/${claim.run.id}/recover-finalization`;
  await assert.rejects(f.api.post(path,{ workerId,stopped:true }),/SERVER_HTTP_409/);
  await f.api.post('status',{ workerId,mode:'PAUSED',busy:true,activeRunId:claim.run.id });
  await assert.rejects(f.api.post(path,{ workerId:'other',stopped:true }),/SERVER_HTTP_403/);
  await assert.rejects(f.api.post(path,{ workerId,stopped:false }),/SERVER_HTTP_400/);
  const recovered = await f.api.post(path,{ workerId,stopped:true }); assert.equal(recovered.action,'finalize_only');
  assert.ok(recovered.lease.fencingToken > claim.lease.fencingToken);
  assert.throws(() => f.store.heartbeat(claim.run.id,credentials(claim)),e => e.code === 'LEASE_INVALID');
  const auth = { workerId,...recovered.lease };
  assert.throws(() => f.store.register(claim.run.id,{ ...auth,registrationKey:'forbidden' }),e => e.code === 'COLLECTION_NOT_AUTHORIZED');
  assert.throws(() => f.store.seal(claim.run.id,c.collectionId,{ ...auth,submission:s }),e => e.code === 'FINALIZATION_ONLY');
  assert.throws(() => f.store.submit(claim.run.id,{ ...auth,submission:s }),e => e.code === 'FINALIZATION_ONLY');
  await f.api.post(`runs/${claim.run.id}/outcome`,{ ...auth,status:'FAILED',errorCode:'OPEN_RESUME_REQUIRES_AUTHORIZATION',summary:{} });
  assert.equal(f.store.db.prepare('SELECT holder FROM profiles').get().holder,null);
});

test('P2 entity列表512KiB README仍为小型元数据响应，详情只保留一种readme字段',async t => {
  const f = await fixture(t); const claim = start(f.store); const s = submission(claim.run,register(f.store,claim),{ text:'x'.repeat(512*1024) }); ingest(f.store,claim,s);
  const listed = f.store.list('entities'); assert.ok(Buffer.byteLength(JSON.stringify(listed))<2048);
  const entity = listed.items[0]; assert.equal(entity.readmeStatus,'found'); assert.equal(entity.readme,undefined); assert.equal(entity.fields,undefined);
  assert.ok(entity.currentVersionId); assert.equal(entity.source,'github-trending');
  const detail = f.store.getEntity(entity.id); assert.equal(detail.entity.readme.text.length,512*1024);
  assert.equal(detail.entity.fields,undefined); assert.equal(detail.versions[0].fields,undefined);
});

test('P2真实GitHub SDK/Poller进度：成功+terminal failed计已处理，预算partial保留pending',async t => {
  const f = await fixture(t); f.store.patchTask(f.taskId,{ config:{ maxRepos:3,itemDelayMs:3000 } }); const run = f.store.createRun(f.taskId,'real-progress');
  let url;
  const poller = f.poller(async use => use({
    async navigate(value) { url = value; return { status:value.endsWith('/failed') ? 404 : value.endsWith('/pending') ? 503 : 200 }; },
    async evaluateRead() { return url.includes('/trending') ? { url,listPresent:true,rows:['good','failed','pending'].map(key => ({ href:`https://github.com/example/${key}` })) } : { url,repoPresent:true,readmePresent:true,text:'仅用于版本保存的正文',pageHref:`${url}#readme-ov-file` }; }
  }),{ heartbeatMs:50 });
  await poller.tick(); const result = f.store.getRun(run.id);
  assert.equal(result.status,'PARTIAL'); assert.equal(result.progress.completed,2); assert.equal(result.progress.total,3);
  assert.equal(result.outcome.summary.succeeded,1); assert.equal(result.outcome.summary.failed,1);
  assert.equal(result.outcome.summary.completed,2); assert.equal(result.outcome.summary.total,3);
  const heartbeats = f.requests.filter(request => request.path.endsWith('/heartbeat'));
  assert.ok(heartbeats.some(request => request.body.progress.completed === 1 && request.body.progress.total === 3));
  assert.ok(heartbeats.some(request => request.body.progress.completed === 2 && request.body.progress.total === 3));
  for (const request of heartbeats) assert.ok(!JSON.stringify(request.body).includes('仅用于版本保存的正文'));
  assert.equal(result.snapshot.entries.find(entry => entry.key === 'example/pending').status,'pending');
});
