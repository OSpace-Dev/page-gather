import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerApi, WorkerPoller } from '../../worker/src/poller.js';
import { Store } from '../store.js';
import { Auth } from '../auth.js';
import { createServer } from '../server.js';

// 使用真实poller/API/SDK/文件spool，仅替换浏览器页面，验证两模块的真实接口。
test('真实poller PAUSED持锁领取，提交后outcome失联，replay_receipt新lease完成pending',async t => {
  const root = mkdtempSync(join(tmpdir(),'server-poller-'));
  let now = Date.now();
  const store = new Store({ filename:':memory:',now:() => now });
  const [password,workerToken] = [randomBytes(32).toString('base64url'),randomBytes(32).toString('base64url')];
  const server = createServer({ store,auth:new Auth({ password,workerToken,publicOrigin:'http://127.0.0.1:18080',secureCookie:false }) });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(root,{ recursive:true,force:true }); });
  const api = new WorkerApi({ url:`http://127.0.0.1:${server.address().port}`,token:workerToken });
  const controller = {
    busy:false,
    status() { return { mode:'PAUSED',busy:this.busy,faulted:false }; },
    async runExternal(action) { assert.equal(this.busy,false); this.busy = true; try { return await action(); } finally { this.busy = false; } }
  };
  const task = store.list('tasks').items[0]; store.patchTask(task.id,{ config:{ maxRepos:1,itemDelayMs:3000 } });
  const run = store.createRun(task.id,'poller-contract-run');
  let navigations = 0;
  const withPage = async use => use({
    async navigate() { navigations++; return { status:200 }; },
    async evaluateRead() { return navigations === 1 ? { url:'https://github.com/trending?since=daily',listPresent:true,rows:[{ href:'https://github.com/example/repo' }] } : { url:'https://github.com/example/repo',repoPresent:true,readmePresent:true,text:'真实SDK协议正文',pageHref:'https://github.com/example/repo#readme-ov-file' }; }
  });
  const failOutcomeApi = { async post(path,body,signal) { if (path.endsWith('/outcome')) throw Object.assign(new Error('TEST_OUTCOME_CONNECTION_LOST'),{ code:'TEST_OUTCOME_CONNECTION_LOST' }); return api.post(path,body,signal); } };
  // statusLoop可能在runExternal期间上报PAUSED/busy=true/activeRunId=null。
  await api.post('status',{ workerId:'worker-main',mode:'PAUSED',busy:true,activeRunId:null });
  const original = new WorkerPoller({ controller,api:failOutcomeApi,spoolRoot:root,withPage });
  await assert.rejects(original.tick(),e => e.code === 'TEST_OUTCOME_CONNECTION_LOST');
  assert.equal(store.run(run.id).status,'RUNNING'); assert.equal(store.list('entities').items.length,1);
  assert.equal((await original.spool.pending()).length,1); assert.equal(navigations,2);
  now += 90001; store.tx(() => store.expire()); assert.equal(store.run(run.id).status,'RECOVERING');
  const restarted = new WorkerPoller({ controller,api,spoolRoot:root,withPage:() => { throw new Error('RECOVERY_MUST_NOT_OPEN_PAGE'); } });
  await restarted.tick();
  assert.equal(store.run(run.id).status,'SUCCEEDED'); assert.equal((await restarted.spool.pending()).length,0);
  assert.equal(store.db.prepare('SELECT holder FROM profiles').get().holder,null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM versions').get().n,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM collections').get().n,1);
});
