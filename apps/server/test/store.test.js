import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.js';
import { hash, JsonCheckpointStore, runPlugin, sealPluginResult, readSealedSubmission } from '../../../packages/plugin-sdk/index.js';
import github from '../../../plugins/github-trending/index.js';
import { workerId, credentials, register, submission, start, ingest } from './helpers.js';
const rejects = (fn,code) => assert.throws(fn, e => e.code === code);
function memory(t,options={}) { const store = new Store({ filename:':memory:', ...options }); t.after(() => store.close()); return store; }

test('SQLite约束、任务验证、手动幂等、不可变任务快照和分页', t => {
  const store = memory(t); const task = store.list('tasks').items[0];
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous,2);
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout,5000);
  rejects(() => store.patchTask(task.id,{ config:{ maxRepos:0 } }), 'INVALID_CONFIG');
  rejects(() => store.patchTask(task.id,{ profileId:'other' }), 'INVALID_TASK');
  const run = store.createRun(task.id,'stable-key');
  store.patchTask(task.id,{ config:{ maxRepos:2 } });
  assert.equal(store.createRun(task.id,'stable-key').id,run.id);
  rejects(() => store.createRun(task.id,'stable-key',{ changed:true }),'IDEMPOTENCY_CONFLICT');
  assert.equal(store.run(run.id).config.maxRepos,25);
  const other = store.createTask({ name:'另一个',pluginId:task.pluginId,pluginVersion:task.pluginVersion,config:{} });
  rejects(() => store.createRun(other.id,'stable-key'),'IDEMPOTENCY_CONFLICT');
  store.createRun(task.id,'another-key');
  const page = store.list('runs',{ limit:1 }); assert.equal(page.items.length,1); assert.ok(page.nextCursor);
  assert.notEqual(store.list('runs',{ limit:1,cursor:page.nextCursor }).items[0].id,run.id);
  rejects(() => store.list('entities',{ cursor:page.nextCursor }),'INVALID_CURSOR');
  const claim = store.claim({ workerId,requestKey:randomUUID() }); const c = register(store,claim);
  const retry = store.register(run.id,{ ...credentials(claim),registrationKey:store.db.prepare('SELECT registration_key FROM collections WHERE id=?').get(c.collectionId).registration_key });
  assert.deepEqual(c,retry); assert.equal(c.taskSnapshotRef,run.taskSnapshotRef);
  assert.equal(store.claim({ workerId,requestKey:randomUUID() }),null);
});

test('seal CAS/hash、未封存拒绝、身份先于收据、原收据优先于更新水位',t => {
  const store = memory(t); const claim = start(store); const old = submission(claim.run,register(store,claim));
  rejects(() => store.submit(claim.run.id,{ ...credentials(claim),submission:old }),'COLLECTION_NOT_SEALED');
  const receipt = ingest(store,claim,old); assert.equal(receipt.disposition,'applied');
  const corrupt = structuredClone(old); corrupt.payload.items[0].readme.text = '变更';
  rejects(() => store.submit(claim.run.id,{ ...credentials(claim),submission:corrupt }),'PAYLOAD_HASH_MISMATCH');
  const conflicting = submission(claim.run,{ collectionId:old.collectionId,collectionSeq:old.collectionSeq,taskSnapshotRef:claim.run.taskSnapshotRef });
  rejects(() => store.seal(claim.run.id,old.collectionId,{ ...credentials(claim),submission:conflicting }),'SEALED_SUBMISSION_CONFLICT');
  const newer = submission(claim.run,register(store,claim),{ text:'更新' }); ingest(store,claim,newer);
  assert.deepEqual(store.submit(claim.run.id,{ workerId,attempt:-1,fencingToken:-1,submission:old }).receipt,receipt);
  rejects(() => store.submit(claim.run.id,{ workerId:'other',submission:old }),'WORKER_IDENTITY_MISMATCH');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM versions').get().n,2);
});

test('新PARTIAL仍RUNNING即推进水位；旧完整包整批STALE归档且不改实体和基线',t => {
  const store = memory(t); const claim = start(store);
  const old = submission(claim.run,register(store,claim),{ text:'旧正文' });
  store.seal(claim.run.id,old.collectionId,{ ...credentials(claim),submission:old });
  const newer = submission(claim.run,register(store,claim),{ text:'新正文',partial:true });
  const fresh = ingest(store,claim,newer);
  assert.equal(store.run(claim.run.id).status,'RUNNING');
  assert.equal(fresh.committedSeqAtDecision,newer.collectionSeq);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM baselines').get().n,0);
  const result = store.submit(claim.run.id,{ ...credentials(claim),submission:old }).receipt;
  assert.equal(result.disposition,'stale'); assert.equal(result.archived,true);
  const archived = store.db.prepare('SELECT archived_payload FROM submissions WHERE id=?').get(old.submissionId);
  assert.deepEqual(JSON.parse(archived.archived_payload),old.payload);
  assert.equal(store.getEntity(store.list('entities').items[0].id).entity.readme.text,'新正文');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM versions').get().n,1);
  assert.equal(store.db.prepare('SELECT committed_seq FROM profiles').get().committed_seq,newer.collectionSeq);
});

test('README A→相同A→B→A保留回退历史；有效空包也推进水位',t => {
  const store = memory(t); const claim = start(store);
  for (const text of ['A','A','B','A']) ingest(store,claim,submission(claim.run,register(store,claim),{ text }));
  const entity = store.list('entities').items[0];
  const detail = store.getEntity(entity.id);
  assert.deepEqual(detail.versions.map(v => v.readme.text),['A','B','A']);
  const page = store.getEntity(entity.id,{ limit:1 }); assert.equal(page.versions.length,1);
  assert.equal(store.getEntity(entity.id,{ limit:1,cursor:page.nextCursor }).versions[0].readme.text,'B');
  const empty = submission(claim.run,register(store,claim),{ empty:true }); const receipt = ingest(store,claim,empty);
  assert.equal(receipt.committedSeqAtDecision,empty.collectionSeq);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM versions').get().n,3);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM baselines').get().n,1);
  assert.equal(store.getRun(claim.run.id).result.snapshot.entries.length,0);
});

test('取消CAS保留已入库数据；停止新采集；终态幂等且锁仅在确认停止后释放',t => {
  const store = memory(t); const claim = start(store); ingest(store,claim,submission(claim.run,register(store,claim)));
  store.cancel(claim.run.id); assert.equal(store.heartbeat(claim.run.id,credentials(claim)).cancelRequested,true);
  rejects(() => register(store,claim),'COLLECTION_NOT_AUTHORIZED');
  assert.equal(store.claim({ workerId,requestKey:randomUUID() }),null);
  const result = store.outcome(claim.run.id,{ ...credentials(claim),status:'CANCELLED' });
  assert.equal(result.run.status,'CANCELLED'); assert.equal(store.list('entities').items.length,1);
  assert.equal(store.outcome(claim.run.id,{ ...credentials(claim),status:'CANCELLED' }).run.status,'CANCELLED');
  assert.equal(store.db.prepare('SELECT holder FROM profiles').get().holder,null);
  const queued = store.createRun(store.list('tasks').items[0].id,randomUUID()); store.cancel(queued.id); assert.equal(store.run(queued.id).status,'CANCELLED');
});

test('租约过期保留锁且不盲领；不接受OPEN续采；恢复令牌只允许上传原包',t => {
  let now = Date.now(); const store = memory(t,{ now:() => now }); const claim = start(store); const c = register(store,claim); const s = submission(claim.run,c);
  now += 90001; store.createRun(claim.run.taskId,randomUUID());
  assert.equal(store.claim({ workerId,requestKey:randomUUID() }),null); assert.equal(store.run(claim.run.id).status,'RECOVERING');
  rejects(() => store.heartbeat(claim.run.id,credentials(claim)),'LEASE_INVALID');
  rejects(() => store.recover(claim.run.id,{ workerId,collectionId:c.collectionId,submissionId:randomUUID(),payloadHash:'bad' }),'INVALID_PAYLOAD_HASH');
  const recovered = store.recover(claim.run.id,{ workerId,collectionId:c.collectionId,submissionId:s.submissionId,payloadHash:s.payloadHash });
  assert.equal(recovered.action,'authorize_upload');
  const resumed = { run:recovered.run,lease:recovered.lease };
  rejects(() => register(store,resumed),'COLLECTION_NOT_AUTHORIZED');
  const receipt = ingest(store,resumed,s);
  const replay = store.recover(claim.run.id,{ workerId,collectionId:c.collectionId,submissionId:s.submissionId,payloadHash:s.payloadHash });
  assert.equal(replay.action,'replay_receipt'); assert.deepEqual(replay.receipt,receipt); assert.ok(replay.lease);
  store.outcome(claim.run.id,{ workerId,...replay.lease,status:'SUCCEEDED' });
  assert.equal(store.db.prepare('SELECT holder FROM profiles').get().holder,null);
});

test('真实SDK SEALED spool重启恢复无页面访问；WAL持久、重启锁和相同包重放',async t => {
  const dir = mkdtempSync(join(tmpdir(),'server-db-'));
  const filename = join(dir,'test.sqlite'); let store = new Store({ filename });
  t.after(() => { store.close(); rmSync(dir,{ recursive:true,force:true }); });
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
  const claim = start(store); const c = register(store,claim); const cpStore = new JsonCheckpointStore({ root:join(dir,'spool') });
  const options = { runId:claim.run.id,...c,config:claim.run.config,deadline:new Date(Date.now()+600000).toISOString(),store:cpStore,withPage:async use => use({
    async navigate() { return { status:200 }; }, async evaluateRead() { return this.list++ ? { url:'https://github.com/example/repo',repoPresent:true,readmePresent:true,text:'SDK text',pageHref:'https://github.com/example/repo#readme-ov-file' } : { url:'https://github.com/trending?since=daily',listPresent:true,rows:[{ href:'https://github.com/example/repo' }] }; }, list:0
  }),clock:{ now:Date.now,sleep:async () => {} },limiter:{ acquire:async () => {},defer(){} } };
  const draft = await runPlugin(github,options); const sealed = await sealPluginResult(github,options,draft);
  store.close(); store = new Store({ filename });
  assert.equal(store.run(claim.run.id).status,'RECOVERING'); assert.equal(store.claim({ workerId,requestKey:randomUUID() }),null);
  const read = await readSealedSubmission(github,{ ...options,withPage:() => { throw new Error('PAGE_MUST_NOT_OPEN'); } }); assert.deepEqual(read,sealed);
  store.workerStatus({ workerId,mode:'PAUSED',busy:true,activeRunId:claim.run.id });
  const recovery = store.recover(claim.run.id,{ workerId,collectionId:c.collectionId,submissionId:read.submissionId,payloadHash:read.payloadHash });
  assert.equal(recovery.action,'authorize_upload');
  const recovered = { run:recovery.run,lease:recovery.lease }; const receipt = ingest(store,recovered,read);
  store.close(); store = new Store({ filename });
  const pendingOutcome = store.recover(claim.run.id,{ workerId,collectionId:c.collectionId,submissionId:read.submissionId,payloadHash:read.payloadHash });
  assert.equal(pendingOutcome.action,'replay_receipt'); assert.ok(pendingOutcome.lease);
  store.outcome(claim.run.id,{ workerId,...pendingOutcome.lease,status:'SUCCEEDED' });
  assert.equal(store.db.prepare('SELECT holder FROM profiles').get().holder,null);
  store.close(); store = new Store({ filename });
  assert.deepEqual(store.submit(claim.run.id,{ workerId,submission:read }).receipt,receipt);
  store.close(); store = new Store({ filename });
  const replay = store.recover(claim.run.id,{ workerId,collectionId:c.collectionId,submissionId:read.submissionId,payloadHash:read.payloadHash });
  assert.equal(replay.action,'replay_receipt'); assert.deepEqual(replay.receipt,receipt);
  assert.equal(store.getRun(claim.run.id).snapshot.entries.length,1);
  assert.equal(store.getRun(claim.run.id).result.items[0].readme.sourceKind,'rendered_page');
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('终态FAILED精确重放且不再重开旧SEALED，不覆盖新的持有者',t => {
  const store = memory(t); const old = start(store); const s = submission(old.run,register(store,old),{ text:'旧批次' });
  store.seal(old.run.id,s.collectionId,{ ...credentials(old),submission:s });
  store.outcome(old.run.id,{ ...credentials(old),status:'FAILED',errorCode:'INGEST_UNAVAILABLE' });
  assert.equal(store.claim({ workerId,requestKey:randomUUID() }),null);
  const newer = start(store); const fresh = submission(newer.run,register(store,newer),{ text:'新批次',partial:true });
  ingest(store,newer,fresh);
  const recoverBody = { workerId,collectionId:s.collectionId,submissionId:s.submissionId,payloadHash:s.payloadHash };
  const terminal = store.recover(old.run.id,recoverBody);
  assert.equal(terminal.action,'terminal'); assert.equal(terminal.outcome.errorCode,'INGEST_UNAVAILABLE');
  assert.equal(store.db.prepare('SELECT holder FROM profiles').get().holder,newer.run.id);
  store.outcome(newer.run.id,{ ...credentials(newer),status:'PARTIAL' });
  assert.equal(store.recover(old.run.id,recoverBody).action,'terminal');
  assert.equal(store.getEntity(store.list('entities').items[0].id).entity.readme.text,'新批次');
  assert.equal(store.list('runs').items.length,2); assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM collections').get().n,2);
});

test('取消后封存已采集partial允许提交，终态竞争保持CANCELLED和原收据',t => {
  const store = memory(t); const claim = start(store); const s = submission(claim.run,register(store,claim),{ partial:true });
  store.cancel(claim.run.id); const receipt = ingest(store,claim,s);
  const result = store.outcome(claim.run.id,{ ...credentials(claim),status:'PARTIAL' }); assert.equal(result.run.status,'CANCELLED');
  assert.equal(store.submit(claim.run.id,{ workerId,submission:s }).receipt.submissionId,receipt.submissionId);
  assert.equal(store.list('entities').items.length,1);
});

test('正常提交正文只存版本一次，固定versionId重建历史payload保持原hash和元数据',t => {
  const store = memory(t); const bodyA = 'README_A_'+ '正文'.repeat(40000); const samples = [];
  for (const [index,text] of [bodyA,bodyA,bodyA,'README_B',bodyA].entries()) {
    const claim = start(store); const s = submission(claim.run,register(store,claim),{ text });
    s.payload.snapshot.entries[0].stars = String(index+1);
    s.payload.items[0].observedAt = `2026-06-01T10:0${index}:00.000Z`;
    s.payloadHash = hash(s.payload);
    ingest(store,claim,s); store.outcome(claim.run.id,{ ...credentials(claim),status:'SUCCEEDED' });
    samples.push({ runId:claim.run.id,submission:s });
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM versions').get().n,3);
  const links = store.db.prepare('SELECT version_id FROM submission_items ORDER BY rowid').all();
  assert.equal(links[0].version_id,links[1].version_id); assert.equal(links[1].version_id,links[2].version_id);
  assert.notEqual(links[0].version_id,links[4].version_id);
  for (const row of store.db.prepare('SELECT payload,archived_payload FROM submissions').all()) {
    assert.ok(!row.payload.includes(bodyA)); assert.equal(row.archived_payload,null); assert.ok(Buffer.byteLength(row.payload)<2048);
    assert.equal(Object.hasOwn(JSON.parse(row.payload).payload,'items'),false);
  }
  for (const row of store.db.prepare('SELECT doc FROM entities').all()) {
    assert.equal(Object.hasOwn(JSON.parse(row.doc),'readme'),false); assert.equal(Object.hasOwn(JSON.parse(row.doc),'fields'),false);
  }
  for (const row of store.db.prepare('SELECT doc FROM versions').all()) assert.equal(Object.hasOwn(JSON.parse(row.doc),'fields'),false);
  for (const sample of samples) {
    const reconstructed = store.getRun(sample.runId).result;
    assert.deepEqual(reconstructed,sample.submission.payload); assert.equal(hash(reconstructed),sample.submission.payloadHash);
  }
  const firstVersion = store.getEntity(store.list('entities').items[0].id).versions[0];
  assert.throws(() => store.db.prepare('DELETE FROM versions WHERE id=?').run(firstVersion.id));
});

test('兼容旧开发库全量提交迁移，保留原hash/收据/结果且去除实体和版本正文副本',t => {
  const root = mkdtempSync(join(tmpdir(),'server-migration-')); const filename = join(root,'test.sqlite');
  let store = new Store({ filename }); t.after(() => { store.close(); rmSync(root,{ recursive:true,force:true }); });
  const claim = start(store); const s = submission(claim.run,register(store,claim)); const receipt = ingest(store,claim,s);
  const entity = store.list('entities').items[0]; const version = store.getEntity(entity.id).versions[0];
  store.db.prepare('DELETE FROM submission_items WHERE submission_id=?').run(s.submissionId);
  store.db.prepare('UPDATE submissions SET payload=? WHERE id=?').run(JSON.stringify(s.payload),s.submissionId);
  store.db.prepare('UPDATE entities SET doc=? WHERE id=?').run(JSON.stringify(entity),entity.id);
  store.db.prepare('UPDATE versions SET doc=? WHERE id=?').run(JSON.stringify(version),version.id);
  store.db.exec('PRAGMA user_version=0'); store.close(); store = new Store({ filename });
  assert.deepEqual(store.getRun(claim.run.id).result,s.payload);
  assert.deepEqual(store.submit(claim.run.id,{ workerId,submission:s }).receipt,receipt);
  assert.equal(JSON.parse(store.db.prepare('SELECT payload FROM submissions').get().payload).storageVersion,1);
  assert.equal(Object.hasOwn(JSON.parse(store.db.prepare('SELECT doc FROM entities').get().doc),'readme'),false);
  assert.equal(Object.hasOwn(JSON.parse(store.db.prepare('SELECT doc FROM versions').get().doc),'fields'),false);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('schema/来源/参数绑定拒绝篡改，事务失败回滚水位和实体',t => {
  const store = memory(t); const claim = start(store); const s = submission(claim.run,register(store,claim));
  const unsafe = structuredClone(s); unsafe.payload.items[0].sourceUrl = 'https://invalid.example/example/repo'; unsafe.payloadHash = hash(unsafe.payload);
  rejects(() => store.seal(claim.run.id,s.collectionId,{ ...credentials(claim),submission:unsafe }),'INVALID_PAYLOAD');
  const altered = structuredClone(s); altered.payload.scopeKey = 'different'; altered.payloadHash = hash(altered.payload);
  rejects(() => store.seal(claim.run.id,s.collectionId,{ ...credentials(claim),submission:altered }),'SNAPSHOT_MISMATCH');
  store.seal(claim.run.id,s.collectionId,{ ...credentials(claim),submission:s });
  store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON submissions BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  assert.throws(() => store.submit(claim.run.id,{ ...credentials(claim),submission:s }));
  assert.equal(store.list('entities').items.length,0); assert.equal(store.db.prepare('SELECT committed_seq FROM profiles').get().committed_seq,0);
});
