import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, MAX_BODY_BYTES } from '../server.js';
import { Auth, configuration } from '../auth.js';
import { Store } from '../store.js';
import { workerId, submission } from './helpers.js';
const origin = 'http://127.0.0.1:18080';
async function fixture(t) {
  const [password,workerToken] = [randomBytes(32).toString('base64url'),randomBytes(32).toString('base64url')];
  const store = new Store({ filename:':memory:' }); const auth = new Auth({ password,workerToken,publicOrigin:origin,secureCookie:false });
  const server = createServer({ store,auth }); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function request(path,{ method='GET',json,cookie,bearer,requestOrigin,headers={} }={}) {
    const response = await fetch(base+path,{ method,headers:{ ...(json !== undefined ? { 'content-type':'application/json' } : {}),...(cookie ? { cookie } : {}),...(bearer ? { authorization:`Bearer ${bearer}` } : {}),...(requestOrigin ? { origin:requestOrigin } : {}),...headers },...(json !== undefined ? { body:JSON.stringify(json) } : {}) });
    const data = response.status === 204 ? null : await response.json();
    return { status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers };
  }
  return { request,password,workerToken,store,auth,base };
}

test('HTTP登录、严格Origin、Cookie/logout、Bearer与用户凭据隔离、错误无敏感内容',async t => {
  const f = await fixture(t); const { request } = f;
  assert.equal((await request('/health')).status,200);
  assert.equal((await request('/tasks')).status,401);
  assert.equal((await request('/auth/login',{ method:'POST',json:{ username:'admin',password:f.password } })).status,403);
  assert.equal((await request('/auth/login',{ method:'POST',json:{ username:'admin',password:f.password },requestOrigin:'http://localhost:18080' })).status,403);
  assert.equal((await request('/auth/login',{ method:'POST',json:{ username:'admin',password:f.workerToken },requestOrigin:origin })).status,401);
  const login = await request('/auth/login',{ method:'POST',json:{ username:'admin',password:f.password },requestOrigin:origin });
  assert.equal(login.status,200); assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/); assert.ok(!login.headers.get('set-cookie').includes('; Secure'));
  const cookie = login.cookie;
  assert.equal((await request('/auth/me',{ cookie })).data.user.username,'admin');
  assert.equal((await request('/tasks',{ bearer:f.workerToken })).status,401);
  assert.equal((await request('/worker/claims',{ method:'POST',cookie,json:{ workerId } })).status,401);
  assert.equal((await request('/worker/claims',{ method:'POST',bearer:f.password,json:{ workerId } })).status,401);
  assert.equal((await request('/worker/status',{ method:'POST',bearer:f.workerToken,json:{ workerId:'other',mode:'AUTO',busy:false,activeRunId:null } })).status,403);
  const denied = await request('/tasks',{ method:'POST',cookie,json:{},requestOrigin:'https://invalid.example' });
  assert.equal(denied.status,403); assert.equal(denied.data.error.code,'ORIGIN_REJECTED'); assert.ok(denied.data.requestId);
  for (const secret of [f.password,f.workerToken]) assert.ok(!JSON.stringify(denied).includes(secret));
  assert.equal((await request('/auth/logout',{ method:'POST',cookie,requestOrigin:origin })).status,200);
  assert.equal((await request('/auth/me',{ cookie })).status,401);
});

test('HTTP完整任务→领取→登记→心跳→seal→入库→终态→榜单及README详情闭环',async t => {
  const f = await fixture(t); const { request } = f;
  const login = await request('/auth/login',{ method:'POST',json:{ username:'admin',password:f.password },requestOrigin:origin });
  const user = { cookie:login.cookie,requestOrigin:origin };
  const worker = { method:'POST',bearer:f.workerToken };
  const task = (await request('/tasks',user)).data.items[0];
  const created = await request(`/tasks/${task.id}/runs`,{ ...user,method:'POST',json:{},headers:{ 'idempotency-key':'http-run-key' } });
  assert.equal(created.status,202);
  assert.equal((await request(`/tasks/${task.id}/runs`,{ ...user,method:'POST',json:{},headers:{ 'idempotency-key':'http-run-key' } })).data.run.id,created.data.run.id);
  assert.equal((await request('/worker/status',{ ...worker,json:{ workerId,mode:'MANUAL',busy:false,activeRunId:null } })).status,200);
  assert.equal((await request('/worker/claims',{ ...worker,json:{ workerId,requestKey:'manual-claim' } })).status,204);
  await request('/worker/status',{ ...worker,json:{ workerId,mode:'PAUSED',busy:true,activeRunId:null } });
  const claimed = await request('/worker/claims',{ ...worker,json:{ workerId,requestKey:'http-claim' } }); assert.equal(claimed.status,200);
  const claim = claimed.data; const auth = { workerId,attempt:claim.lease.attempt,fencingToken:claim.lease.fencingToken };
  for (const k of ['id','taskId','pluginId','pluginVersion','profileId','config','taskSnapshotRef','deadline']) assert.ok(claim.run[k]);
  const prefix = `/worker/runs/${claim.run.id}`;
  const c = (await request(`${prefix}/collections`,{ ...worker,json:{ ...auth,registrationKey:'http-collection' } })).data;
  assert.equal((await request(`${prefix}/heartbeat`,{ ...worker,json:{ ...auth,progress:{ phase:'COLLECT',itemKey:'example/repo',completed:1,total:1 } } })).status,200);
  assert.equal((await request(`${prefix}/outcome`,{ ...worker,json:{ ...auth,status:'SUCCEEDED' } })).data.error.code,'RECEIPT_REQUIRED');
  const s = submission(claim.run,c);
  assert.equal((await request(`${prefix}/collections/${c.collectionId}/seal`,{ ...worker,json:{ ...auth,submission:s } })).status,200);
  const applied = await request(`${prefix}/submissions`,{ ...worker,json:{ ...auth,submission:s } }); assert.equal(applied.data.receipt.disposition,'applied');
  assert.equal((await request(`${prefix}/outcome`,{ ...worker,json:{ ...auth,status:'SUCCEEDED',summary:{ completed:1 } } })).status,200);
  const detail = (await request(`/runs/${claim.run.id}`,user)).data.run;
  assert.equal(detail.snapshot.entries.length,1); assert.equal(detail.result.items[0].readme.format,'rendered_text'); assert.equal(detail.status,'SUCCEEDED'); assert.ok(detail.outcome);
  const entities = await request('/entities?limit=1&q=example&type=repository_readme',user);
  const entity = await request(`/entities/${entities.data.items[0].id}`,user);
  assert.equal(entity.data.entity.readme.text,s.payload.items[0].readme.text); assert.equal(entity.data.versions.length,1);
  assert.equal((await request('/entities?limit=201',user)).status,400);
  assert.equal((await request('/artifacts/upload',{ ...user,method:'POST',json:{} })).data.error.code,'ARTIFACT_UPLOAD_NOT_IMPLEMENTED');
});

test('登录限速、JSON有界且先认证worker，配置文件与生产Secure失败安全',async t => {
  const f = await fixture(t);
  const wrongValue = randomBytes(8).toString('hex');
  for (let n=0;n<5;n++) assert.equal((await f.request('/auth/login',{ method:'POST',requestOrigin:origin,json:{ username:'admin',password:wrongValue } })).status,401);
  assert.equal((await f.request('/auth/login',{ method:'POST',requestOrigin:origin,json:{ username:'admin',password:f.password } })).status,429);
  const large = 'x'.repeat(MAX_BODY_BYTES);
  assert.equal((await f.request('/worker/status',{ method:'POST',json:{ large } })).status,401);
  const oversized = await f.request('/worker/status',{ method:'POST',bearer:f.workerToken,json:{ large } }); assert.equal(oversized.status,413);
  const chunked = await fetch(f.base+'/worker/status',{ method:'POST',headers:{ 'content-type':'application/json',authorization:`Bearer ${f.workerToken}` },body:(async function* () { yield '{"large":"'; for (let n=0;n<11;n++) yield 'x'.repeat(1024*1024); yield '"}'; })(),duplex:'half' });
  assert.equal(chunked.status,413); assert.equal((await chunked.json()).error.code,'REQUEST_TOO_LARGE');
  const dir = mkdtempSync(join(tmpdir(),'server-secret-')); t.after(() => rmSync(dir,{ recursive:true,force:true }));
  const passwordFile = join(dir,'admin'); const tokenFile = join(dir,'worker');
  writeFileSync(passwordFile,f.password,{ mode:0o600 }); writeFileSync(tokenFile,f.workerToken,{ mode:0o600 });
  const env = { PAGE_GATHER_PUBLIC_ORIGIN:origin,PAGE_GATHER_ADMIN_PASSWORD_FILE:passwordFile,PAGE_GATHER_WORKER_TOKEN_FILE:tokenFile };
  assert.equal(configuration(env).secureCookie,false);
  assert.throws(() => configuration({ ...env,PAGE_GATHER_ADMIN_PASSWORD_FILE:undefined }),e => e.code === 'SECRET_FILE_REQUIRED');
  assert.throws(() => configuration({ ...env,NODE_ENV:'production' }),e => e.code === 'PRODUCTION_HTTPS_REQUIRED');
  assert.equal(configuration({ ...env,NODE_ENV:'production',PAGE_GATHER_PUBLIC_ORIGIN:'https://gather.example' }).secureCookie,true);
  const secureAuth = new Auth({ password:f.password,workerToken:f.workerToken,publicOrigin:'https://gather.example' }); assert.match(secureAuth.cookie('value',60),/; Secure$/);
});
