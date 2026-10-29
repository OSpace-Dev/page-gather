import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { Dispatcher, deliveryResult, retryAfter, MAX_RETRY_AFTER_MS } from '../dispatcher.js';
import { subscriptionInput } from '../notify-store.js';
import { createServer } from '../server.js';
import { Auth } from '../auth.js';
import { hash } from '../../../packages/plugin-sdk/index.js';
import { contentHash } from '../../../plugins/github-trending/index.js';
import { workerId, start, credentials, submission, register, ingest } from './helpers.js';

// 全部是隔离数据库、真实HTTP与合成订阅；绝不连接外部push或修改用户记录。
const enabled = { enabled: true, configured: true, publicKey: 'synthetic-public-key', privateKey: 'synthetic-private-key', subject: 'mailto:test@example.invalid', reason: null };
function device(suffix = randomUUID()) {
  const curve = createECDH('prime256v1'); curve.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, expirationTime: null };
}
function timers() {
  let seq = 0; const jobs = new Map();
  return { jobs, setTimer: (fn, delay) => { const id = ++seq; jobs.set(id, { fn, delay }); return id; }, clearTimer: id => jobs.delete(id) };
}
function fixture(t, config = enabled) {
  let now = Date.now(); const store = new Store({ filename: ':memory:', pushConfig: config, now: () => now });
  t.after(() => store.close());
  const claim = start(store); const notifications = store.notifications;
  return { store, claim, notifications, advance: ms => { now += ms; }, add: opts => { const s = submission(claim.run, register(store, claim), opts); ingest(store, claim, s); return s; } };
}
function enablePush(n) { const rule = n.rules().items[0]; n.patchRule(rule.id, { pushEnabled: true }); return rule.id; }
function dispatcher(t, n, transport, opts = {}) {
  const clock = timers(); const d = new Dispatcher(n, transport, { ...clock, ...opts }); d.start(); t.after(() => d.stop()); return { d, clock };
}
const counts = (store, table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const delivery = store => store.db.prepare('SELECT * FROM push_deliveries ORDER BY rowid').all();

test('首次partial静默、首次complete只一条baseline，已有版本不补通知；原收据及STALE均不重放', t => {
  const f = fixture(t); const { store, claim, notifications: n } = f;
  const partial = f.add({ text: 'A', partial: true }); assert.equal(n.list().items.length, 0);
  const old = submission(claim.run, register(store, claim), { text: 'OLD' }); store.seal(claim.run.id, old.collectionId, { ...credentials(claim), submission: old });
  f.add({ text: 'A' }); assert.equal(n.list().items.length, 1); assert.equal(n.list().items[0].kind, 'baseline');
  const summary = n.list().items[0]; assert.equal(summary.versionId, null); assert.equal(summary.runId, claim.run.id);
  assert.match(summary.targetPath, /^\/runs\?runId=[A-Za-z0-9-]+$/);
  assert.equal(store.submit(claim.run.id, { ...credentials(claim), submission: old }).receipt.disposition, 'stale');
  store.submit(claim.run.id, { workerId, submission: partial });
  f.add({ text: 'A' }); assert.equal(n.list().items.length, 1);
  assert.equal(counts(store, 'events'), 1); assert.equal(counts(store, 'notification_outbox'), 1);
});

test('完整基线空包一条摘要；多实体历史不逐项提醒，后续新实体created', t => {
  const f = fixture(t); f.add({ empty: true }); assert.equal(f.notifications.list().items[0].kind, 'baseline');
  f.add({ text: 'A' }); assert.equal(f.notifications.list().items[0].kind, 'created');
  const g = fixture(t); const s = submission(g.claim.run, register(g.store, g.claim));
  const item = structuredClone(s.payload.items[0]); item.sourceKey = item.queueKey = 'example/second'; item.sourceUrl = 'https://github.com/example/second'; item.rank = 2; item.readme.sourceUrl = item.sourceUrl + '#readme-ov-file'; item.contentHash = contentHash(item);
  s.payload.items.push(item); s.payload.snapshot.entries.push({ ...s.payload.snapshot.entries[0], key: item.sourceKey, url: item.sourceUrl, rank: 2 }); s.payloadHash = hash(s.payload);
  ingest(g.store, g.claim, s); assert.equal(counts(g.store, 'events'), 2); assert.equal(g.notifications.list().items.length, 1);
  const reordered = submission(g.claim.run, register(g.store, g.claim));
  reordered.payload.snapshot.entries = structuredClone(s.payload.snapshot.entries).reverse().map((entry, i) => ({ ...entry, rank: i + 1 }));
  reordered.payload.items = structuredClone(s.payload.items).map(item => ({ ...item, rank: reordered.payload.snapshot.entries.find(entry => entry.key === item.sourceKey).rank }));
  reordered.payloadHash = hash(reordered.payload); ingest(g.store, g.claim, reordered);
  assert.equal(counts(g.store, 'events'), 2); assert.equal(g.notifications.list().items.length, 1, '榜单排序不触发README变化');
});

test('baseline后A→相同A→B→A、rank/stars/时间不提醒；多rule按同version去重且固定原run/version', t => {
  const f = fixture(t); const { notifications: n, store, claim } = f;
  const extra = n.createRule({ name: '额外规则', keywords: ['EXAMPLE'], eventTypes: ['changed'] });
  f.add({ text: 'A' }); const unchanged = submission(claim.run, register(store, claim), { text: 'A' });
  unchanged.payload.snapshot.entries[0].stars = '999'; unchanged.payload.items[0].observedAt = '2026-06-01T12:00:00.000Z'; unchanged.payloadHash = hash(unchanged.payload); ingest(store, claim, unchanged);
  const b = f.add({ text: 'B' }); f.add({ text: 'A' });
  const all = n.list().items; assert.deepEqual(all.map(x => x.kind), ['changed','changed','baseline']);
  assert.equal(all[1].matchedRuleIds.length, 2); assert.ok(all[1].matchedRuleIds.includes(extra.id));
  const rawVersion = JSON.parse(store.db.prepare('SELECT doc FROM versions WHERE id=?').get(all[1].versionId).doc);
  assert.equal(rawVersion.readme.text, 'B'); assert.equal(all[1].runId, claim.run.id); assert.ok(all[1].targetPath.endsWith(`&versionId=${rawVersion.id}`));
  assert.ok(!JSON.stringify(all).includes('readme')); assert.ok(!store.db.prepare('SELECT doc FROM notifications').all().some(row => row.doc.includes('README 内容')));
  store.submit(claim.run.id, { workerId, submission: b }); assert.equal(n.list().items.length, 3);
});

test('规则enabled/taskIds/eventTypes/关键词正文和描述过滤，不匹配时间；变更不补历史', t => {
  const f = fixture(t); const { notifications: n, store, claim } = f; const defaultId = n.rules().items[0].id;
  n.patchRule(defaultId, { enabled: false });
  const other = store.createTask({ name: '其他任务', pluginId: claim.run.pluginId, pluginVersion: claim.run.pluginVersion });
  n.createRule({ name: '错误任务', taskIds: [other.id] });
  const rule = n.createRule({ name: '内容过滤', taskIds: [claim.run.taskId], eventTypes: ['changed'], keywords: ['needle'] });
  f.add({ text: 'A' }); f.add({ text: 'B' }); assert.equal(n.list().items.length, 0);
  f.add({ text: 'NEEDLE' }); assert.equal(n.list().items.length, 1);
  n.patchRule(rule.id, { keywords: ['description-only'] }); assert.equal(n.list().items.length, 1);
  const s = submission(claim.run, register(store, claim), { text: 'C' }); s.payload.snapshot.entries[0].description = 'description-only'; s.payloadHash = hash(s.payload); ingest(store, claim, s); assert.equal(n.list().items.length, 2);
  n.patchRule(rule.id, { keywords: ['2026-06-01'] }); f.add({ text: 'D' }); assert.equal(n.list().items.length, 2);
  assert.throws(() => n.patchRule(rule.id, { eventTypes: ['invented'] }), e => e.code === 'INVALID_RULE');
  assert.throws(() => n.createRule({ name: 'SQL', code: 'SELECT 1' }), e => e.code === 'INVALID_RULE');
  n.deleteRule(rule.id); assert.equal(n.list().items.length, 2);
});

test('跨任务共享同版本不重发；第二task自己首次complete只有summary', t => {
  const f = fixture(t); f.add({ text: 'A' });
  f.store.outcome(f.claim.run.id, { ...credentials(f.claim), status: 'SUCCEEDED' });
  const task = f.store.createTask({ name: '第二个来源任务', pluginId: f.claim.run.pluginId, pluginVersion: f.claim.run.pluginVersion });
  const second = start(f.store, task.id);
  ingest(f.store, second, submission(second.run, register(f.store, second), { text: 'A' }));
  assert.deepEqual(f.notifications.list().items.map(x => x.kind), ['baseline','baseline']);
  ingest(f.store, second, submission(second.run, register(f.store, second), { text: 'B' }));
  f.store.outcome(second.run.id, { ...credentials(second), status: 'SUCCEEDED' });
  const third = start(f.store, f.claim.run.taskId); ingest(f.store, third, submission(third.run, register(f.store, third), { text: 'B' }));
  assert.deepEqual(f.notifications.list().items.map(x => x.kind), ['changed','baseline','baseline']); assert.equal(counts(f.store, 'versions'), 2);
});

test('首来源策略：onlyB规则不补A先写而B后提交同version的delta，B基线可独立summary', t => {
  for (const establishBFirst of [false, true]) {
    const f = fixture(t); const { store, notifications: n } = f;
    const taskB = store.createTask({ name: '仅此任务订阅', pluginId: f.claim.run.pluginId, pluginVersion: f.claim.run.pluginVersion });
    n.patchRule(n.rules().items[0].id, { taskIds: [taskB.id] });
    f.add({ text: 'old-A' }); store.outcome(f.claim.run.id, { ...credentials(f.claim), status: 'SUCCEEDED' }); assert.equal(n.list().items.length, 0);
    const collect = (taskId, text) => {
      const claim = start(store, taskId); ingest(store, claim, submission(claim.run, register(store, claim), { text }));
      store.outcome(claim.run.id, { ...credentials(claim), status: 'SUCCEEDED' }); return claim;
    };
    if (establishBFirst) collect(taskB.id, 'old-A');
    const fromA = collect(f.claim.run.taskId, 'new-A'); const version = store.list('entities').items[0].currentVersionId;
    assert.equal(JSON.parse(store.db.prepare('SELECT doc FROM versions WHERE id=?').get(version).doc).runId, fromA.run.id);
    collect(taskB.id, 'new-A');
    const all = n.list().items; assert.equal(all.length, 1); assert.equal(all[0].kind, 'baseline'); assert.equal(all[0].taskId, taskB.id);
    assert.equal(all.some(item => item.versionId === version), false, 'B相同version不补发A来源delta');
    collect(taskB.id, 'new-B'); assert.deepEqual(n.list().items.map(item => item.kind), ['changed','baseline']);
  }
});

test('升级保留旧P2/P3结果及baseline、事件不迁移通知；重启与删空规则不复活默认', t => {
  const dir = mkdtempSync(join(tmpdir(), 'p4-upgrade-')); const filename = join(dir, 'test.sqlite');
  let store = new Store({ filename }); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const claim = start(store); const s = submission(claim.run, register(store, claim), { text: 'A' }); const receipt = ingest(store, claim, s);
  store.db.exec('DROP TABLE push_test_requests; DROP TABLE push_deliveries; DROP TABLE notification_outbox; DROP TABLE notifications; DROP TABLE push_subscriptions; DROP TABLE notification_rules; DROP TABLE notification_migrations;');
  store.close(); store = new Store({ filename });
  assert.equal(store.notifications.list().items.length, 0); assert.equal(counts(store, 'events'), 1); assert.equal(counts(store, 'baselines'), 1);
  assert.deepEqual(store.submit(claim.run.id, { workerId, submission: s }).receipt, receipt);
  assert.equal(store.notifications.list().items.length, 0); assert.equal(store.getRun(claim.run.id).result.items[0].readme.text, 'A');
  const rule = store.notifications.rules().items[0]; store.notifications.deleteRule(rule.id); store.close(); store = new Store({ filename }); assert.equal(store.notifications.rules().items.length, 0);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('通知/Outbox/设备计划/receipt/版本/baseline/水位同一事务，后续失败全回滚', t => {
  const f = fixture(t); enablePush(f.notifications); f.notifications.registerDevice({ subscription: device() }, 'owner');
  const s = submission(f.claim.run, register(f.store, f.claim)); f.store.seal(f.claim.run.id, s.collectionId, { ...credentials(f.claim), submission: s });
  for (const table of ['push_deliveries','submissions']) {
    f.store.db.exec(`CREATE TRIGGER fail_p4 BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'isolated rollback'); END`);
    assert.throws(() => f.store.submit(f.claim.run.id, { ...credentials(f.claim), submission: s }));
    for (const name of ['notifications','notification_outbox','push_deliveries','versions','events','submissions','baselines']) assert.equal(counts(f.store, name), 0, name);
    assert.equal(f.store.db.prepare('SELECT committed_seq FROM profiles').get().committed_seq, 0);
    f.store.db.exec('DROP TRIGGER fail_p4');
  }
  ingest(f.store, f.claim, s); assert.equal(counts(f.store, 'push_deliveries'), 1);
});

test('事件时设备/rulepush/globalpush三重计划门槛，后注册或后启用不补历史', t => {
  const f = fixture(t); const { notifications: n, store } = f;
  f.add({ text: 'A' }); assert.equal(counts(store, 'push_deliveries'), 0);
  n.registerDevice({ subscription: device() }, 'owner'); assert.equal(counts(store, 'push_deliveries'), 0);
  f.add({ text: 'B' }); assert.equal(counts(store, 'push_deliveries'), 0);
  enablePush(n); assert.equal(counts(store, 'push_deliveries'), 0);
  f.add({ text: 'C' }); assert.equal(counts(store, 'push_deliveries'), 1);
  n.registerDevice({ subscription: device() }, 'owner2'); assert.equal(counts(store, 'push_deliveries'), 1);
  n.configure({ ...enabled, enabled: false }); f.add({ text: 'D' }); assert.equal(counts(store, 'push_deliveries'), 1); assert.equal(delivery(store)[0].status, 'skipped');
  n.configure(enabled); assert.equal(counts(store, 'push_deliveries'), 1); assert.equal(delivery(store)[0].status, 'skipped');
});

test('全局关闭重启清理旧pending/retry/lease，reenable不重发；test不依赖业务rule', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'p4-global-off-')); const filename = join(dir, 'test.sqlite');
  let store = new Store({ filename, pushConfig: enabled }); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  enablePush(store.notifications); const meta = store.notifications.registerDevice({ subscription: device() }, 'owner');
  const claim = start(store); for (const text of ['A','B','C']) ingest(store, claim, submission(claim.run, register(store, claim), { text }));
  const sending = store.notifications.claimDelivery(30000); const retrying = store.notifications.claimDelivery(30000); store.notifications.finishDelivery(retrying, { status: 'retry', code: 'PUSH_TIMEOUT', delay: 60000 });
  assert.deepEqual(delivery(store).map(row => row.status).sort(), ['pending','retry','sending']);
  store.close(); store = new Store({ filename, pushConfig: { ...enabled, enabled: false } });
  assert.ok(delivery(store).every(row => row.status === 'skipped' && row.last_code === 'PUSH_DISABLED')); assert.equal(store.notifications.claimDelivery(30000), null);
  store.notifications.configure(enabled); assert.equal(store.notifications.claimDelivery(30000), null);
  for (const rule of store.notifications.rules().items) store.notifications.deleteRule(rule.id);
  const n = store.notifications.testPush('only-selected-test', { subscriptionId: meta.id }, 'owner'); assert.equal(n.kind, 'test'); assert.equal(n.matchedRuleIds.length, 0);
  assert.equal(store.notifications.claimDelivery(30000).notification_id, n.id, 'test无需业务rule授权');
  store.notifications.finishDelivery(sending, { status: 'accepted', code: 'PUSH_SERVICE_ACCEPTED' }); assert.ok(delivery(store).filter(row => row.notification_id !== n.id).every(row => row.status === 'skipped'));
});

test('禁用/删除规则或设备永久阻止pending，不因以后启用或重注册恢复历史；多个push规则剩一可发送', t => {
  const f = fixture(t); const n = f.notifications; const rule = enablePush(n);
  const second = n.createRule({ name: '第二push规则', pushEnabled: true }); const subscription = device(); const metadata = n.registerDevice({ subscription }, 'owner');
  f.add({ text: 'A' }); n.patchRule(rule, { enabled: false }); assert.equal(delivery(f.store)[0].status, 'pending');
  n.deleteRule(second.id); assert.equal(delivery(f.store)[0].status, 'skipped'); n.patchRule(rule, { enabled: true }); assert.equal(delivery(f.store)[0].status, 'skipped');
  f.add({ text: 'B' }); n.removeDevice(metadata.id, 'owner'); assert.equal(delivery(f.store)[1].status, 'skipped');
  assert.equal(f.store.db.prepare('SELECT secret FROM push_subscriptions WHERE id=?').get(metadata.id).secret, null);
  n.registerDevice({ subscription }, 'owner'); assert.equal(delivery(f.store)[1].status, 'skipped');
});

test('运行中关闭全局push立即清timer/abort并skip，重新开启不复活旧lease', async t => {
  const f = fixture(t); const n = f.notifications; enablePush(n); n.registerDevice({ subscription: device() }, 'owner'); f.add({ text: 'A' });
  let signal; let calls = 0; const { d, clock } = dispatcher(t, n, async args => { signal = args.signal; calls++; return new Promise(() => {}); });
  const sending = d.run(); await new Promise(resolve => setImmediate(resolve)); n.configure({ ...enabled, enabled: false });
  assert.equal(signal.aborted, true); assert.equal(clock.jobs.size, 0); assert.equal(delivery(f.store)[0].status, 'skipped');
  await sending; assert.equal(d.status().enabled, false); assert.equal(d.status().nextWakeAt, null);
  n.configure(enabled); await d.run(); assert.equal(calls, 1); assert.equal(delivery(f.store)[0].status, 'skipped');
});

test('设备订阅端点/密钥校验、元数据无secret、跨session归属拒绝、原密钥可续绑', t => {
  const f = fixture(t); const n = f.notifications; const subscription = device();
  const meta = n.registerDevice({ subscription, deviceLabel: '合成设备' }, 'first');
  assert.equal(n.devices('first').items[0].owned, true); assert.equal(n.devices('second').items[0].owned, false);
  const value = JSON.stringify(n.devices('first')); for (const secret of [subscription.endpoint, subscription.keys.auth, subscription.keys.p256dh, 'first']) assert.ok(!value.includes(secret));
  assert.throws(() => n.removeDevice(meta.id, 'second'), e => e.code === 'SUBSCRIPTION_NOT_OWNED');
  assert.throws(() => n.registerDevice({ subscription: { ...subscription, keys: device().keys } }, 'second'), e => e.code === 'SUBSCRIPTION_CONFLICT');
  n.registerDevice({ subscription }, 'second'); assert.equal(n.devices('first').items[0].owned, false); n.removeDevice(meta.id, 'second'); assert.equal(n.devices('second').items.length, 0);
  for (const endpoint of ['https://localhost/a','http://fcm.googleapis.com/a','https://fcm.googleapis.com:444/a','https://fcm.googleapis.com.evil.invalid/a','https://user@fcm.googleapis.com/a','https://fcm.googleapis.com/a#','https://fcm.googleapis.com/a\n']) assert.throws(() => subscriptionInput({ ...subscription, endpoint }), e => e.code === 'INVALID_PUSH_ENDPOINT');
  assert.throws(() => subscriptionInput({ ...subscription, keys: { ...subscription.keys, auth: 'bad' } }), e => e.code === 'INVALID_SUBSCRIPTION_KEYS');
});

test('通知倒序分页、游标绑定过滤、已读幂等与read-all；历史版本目标不随最新版本漂移', t => {
  const f = fixture(t); for (const text of ['A','B','C']) f.add({ text }); const n = f.notifications;
  const first = n.list({ limit: 1, unread: 'true' }); const second = n.list({ limit: 1, unread: 'true', cursor: first.nextCursor });
  assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(first.items[0].body, 'example/repo');
  assert.throws(() => n.list({ cursor: first.nextCursor }), e => e.code === 'INVALID_CURSOR');
  assert.throws(() => n.list({ limit: 201 }), e => e.code === 'INVALID_LIMIT'); assert.throws(() => n.list({ unread: 'yes' }), e => e.code === 'INVALID_UNREAD');
  assert.equal(n.unreadCount().count, 3); const read = n.read(first.items[0].id, { read: true }); f.advance(100); assert.equal(n.read(read.id, { read: true }).readAt, read.readAt);
  assert.equal(n.unreadCount().count, 2); assert.equal(n.readAll().count, 2); assert.equal(n.readAll().count, 0); assert.equal(n.list({ unread: 'false' }).items.length, 3);
  assert.throws(() => n.read(read.id, { read: false }), e => e.code === 'INVALID_READ');
});

test('dispatcher串行、事务外transport、稳定notificationId/tag，accepted不标已读/设备展示', async t => {
  const f = fixture(t); enablePush(f.notifications); f.notifications.registerDevice({ subscription: device() }, 'owner'); f.add({ text: 'A' }); f.add({ text: 'B' });
  const calls = []; let release;
  const { d } = dispatcher(t, f.notifications, async args => {
    calls.push(args); assert.equal(f.store.db.isTransaction, false); await new Promise(resolve => { release = resolve; }); return { statusCode: 201 };
  });
  const a = d.run(); const b = d.run(); assert.equal(a, b); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 1);
  release(); await a; const accepted = delivery(f.store).find(row => row.notification_id === calls[0].notificationId); assert.equal(accepted.status, 'accepted'); assert.equal(accepted.attempts, 1);
  assert.equal(calls[0].notificationId, calls[0].payload.tag); assert.match(calls[0].payload.targetPath, /^\/notifications\?id=/); assert.ok(!JSON.stringify(calls[0].payload).includes('example/repo'));
  const next = d.run(); await new Promise(resolve => setImmediate(resolve)); release(); await next; assert.equal(calls.length, 2); assert.equal(f.notifications.unreadCount().count, 2); assert.equal(d.status().counts.accepted, 2);
});

test('429/5xx/network最多五次指数退避，Retry-After秒/日期上限，持久attempt与固定诊断', async t => {
  const f = fixture(t); enablePush(f.notifications); f.notifications.registerDevice({ subscription: device() }, 'owner'); f.add({ text: 'A' });
  let calls = 0; const { d } = dispatcher(t, f.notifications, async () => { calls++; throw Object.assign(new Error('never expose endpoint or secrets'), { code: 'PUSH_HTTP_ERROR', statusCode: 429, safeRetryAfter: 999999999 }); });
  for (let i = 1; i <= 5; i++) {
    await d.run(); const row = delivery(f.store)[0]; assert.equal(row.attempts, i); assert.equal(row.status, i === 5 ? 'failed' : 'retry');
    if (i < 5) { assert.equal(row.due_at - f.store.now(), MAX_RETRY_AFTER_MS); await d.run(); assert.equal(calls, i); }
    f.advance(MAX_RETRY_AFTER_MS + 1);
  }
  await d.run(); assert.equal(calls, 5); assert.equal(d.status().lastErrorCode, 'PUSH_RATE_LIMITED');
  assert.equal(retryAfter({ 'Retry-After': new Date(f.store.now() + 120000).toUTCString() }, f.store.now()) <= 120000, true);
  assert.equal(retryAfter({ 'retry-after': 'bad' }, f.store.now()), 0);
  for (const result of [{ statusCode: 503 }, { code: 'PUSH_TIMEOUT' }, { code: 'PUSH_NETWORK_ERROR' }]) assert.equal(deliveryResult(result, 1, f.store.now()).status, 'retry');
});

test('404/410清单设备密钥、不影响其他设备；401/403/413保设备并有限失败，安全失败不retry', async t => {
  for (const statusCode of [404,410,401,403,413]) {
    const f = fixture(t); const n = f.notifications; enablePush(n);
    n.registerDevice({ subscription: device() }, 'owner'); n.registerDevice({ subscription: device() }, 'other'); f.add({ text: 'A' });
    const { d } = dispatcher(t, n, async () => ({ statusCode })); await d.run();
    const rows = delivery(f.store); assert.equal(rows.filter(row => row.status === 'failed').length, 1); assert.equal(rows.find(row => row.status === 'failed').attempts, 1); assert.equal(rows.filter(row => row.status === 'pending').length, 1);
    assert.equal(n.devices('owner').items.length, [404,410].includes(statusCode) ? 1 : 2); assert.equal(d.status().healthy, true);
  }
  assert.equal(deliveryResult({ code: 'PUSH_DNS_BLOCKED' }, 1, Date.now()).status, 'failed');
  assert.equal(deliveryResult({ code: 'PUSH_DNS_FAILED' }, 1, Date.now()).status, 'retry');
});

test('dispatcher空闲60s低频、提交唤醒；关键词修订不追溯pending；本地失败退避后恢复', async t => {
  const f = fixture(t); const n = f.notifications; const ruleId = enablePush(n); n.registerDevice({ subscription: device() }, 'owner');
  let sent = 0; const { d, clock } = dispatcher(t, n, async () => { sent++; return { statusCode: 201 }; });
  await d.run(); assert.equal([...clock.jobs.values()][0].delay, 60000);
  f.add({ text: 'A' }); assert.equal([...clock.jobs.values()][0].delay, 0);
  n.patchRule(ruleId, { keywords: ['not-in-the-old-event'], taskIds: [], eventTypes: ['changed'] });
  await d.run(); assert.equal(sent, 1); assert.equal(delivery(f.store)[0].status, 'accepted', '旧事件只复核原授权rule的开关，不重算过滤');
  const original = n.claimDelivery; n.claimDelivery = () => { throw new Error('private SQL detail'); };
  await d.run(); assert.equal(d.status().healthy, false); assert.equal(d.status().lastErrorCode, 'PUSH_DISPATCHER_FAILED'); assert.equal([...clock.jobs.values()][0].delay, 1000);
  n.patchRule(ruleId, { name: '不绕过本地故障退避' }); assert.equal([...clock.jobs.values()][0].delay, 1000);
  n.claimDelivery = original; await d.run(); assert.equal(d.status().healthy, true); assert.equal([...clock.jobs.values()][0].delay, 60000);
});

test('文件SQLite lease重启：到期才回收、attempt递增、稳定id至少一次、第五次lease崩溃后终止', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'p4-leases-')); const filename = join(dir, 'test.sqlite'); let now = Date.now();
  let store = new Store({ filename, now: () => now, pushConfig: enabled }); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  enablePush(store.notifications); store.notifications.registerDevice({ subscription: device() }, 'owner');
  const claim = start(store); ingest(store, claim, submission(claim.run, register(store, claim)));
  const first = store.notifications.claimDelivery(30000); assert.equal(first.attempts, 1); const id = first.notification_id;
  store.close(); store = new Store({ filename, now: () => now, pushConfig: enabled }); assert.equal(store.notifications.claimDelivery(30000), null);
  now += 30001; const second = store.notifications.claimDelivery(30000); assert.equal(second.notification_id, id); assert.equal(second.attempts, 2);
  store.notifications.finishDelivery(first, { status: 'accepted', code: 'PUSH_SERVICE_ACCEPTED' }); assert.equal(delivery(store)[0].status, 'sending', '旧lease不可完成新lease');
  for (let i = 3; i <= 5; i++) { now += 30001; assert.equal(store.notifications.claimDelivery(30000).attempts, i); }
  now += 30001; assert.equal(store.notifications.claimDelivery(30000), null); assert.equal(delivery(store)[0].status, 'failed'); assert.equal(delivery(store)[0].last_code, 'PUSH_ATTEMPTS_EXHAUSTED');
});

test('超时与忽略Abort的transport有界；stop取消先于DB关闭、未完成lease保留给重启', async t => {
  const f = fixture(t); enablePush(f.notifications); f.notifications.registerDevice({ subscription: device() }, 'owner'); f.add({ text: 'A' });
  let signal; const d = new Dispatcher(f.notifications, async args => { signal = args.signal; return new Promise(() => {}); }, { timeoutMs: 15, leaseMs: 100 });
  d.start(); await d.run(); assert.equal(signal.aborted, true); assert.equal(delivery(f.store)[0].status, 'retry'); assert.equal(delivery(f.store)[0].last_code, 'PUSH_TIMEOUT');
  f.advance(60001); const pending = d.run(); await new Promise(resolve => setImmediate(resolve)); await d.stop(); await pending;
  assert.equal(signal.aborted, true); assert.equal(delivery(f.store)[0].status, 'sending'); assert.equal(d.status().running, false); assert.equal(d.status().nextWakeAt, null);
});

async function httpFixture(t, pushConfig = enabled, extra = {}) {
  const [password, workerToken] = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')]; const origin = 'http://localhost:18082';
  const store = new Store({ filename: ':memory:', pushConfig }); const auth = new Auth({ password, workerToken, publicOrigin: origin, secureCookie: false });
  const clock = timers(); const server = createServer({ store, auth, pushConfig, pushTransport: async () => ({ statusCode: 201 }), dispatcherOptions: clock, ...extra });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function request(path, { method = 'GET', cookie, json, key, headers = {}, noOrigin = false } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(!noOrigin && method !== 'GET' ? { origin } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}), ...headers }, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = async () => (await request('/auth/login', { method: 'POST', json: { username: 'admin', password } })).cookie;
  return { server, store, request, login, workerToken, cookie: await login(), clock };
}

test('真实HTTP通知/规则CRUD/分页/read接口与headers；管理员session+Origin，worker不能访问', async t => {
  const f = await httpFixture(t); const { request, cookie, store } = f; const claim = start(store); for (const text of ['A','B']) ingest(store, claim, submission(claim.run, register(store, claim), { text }));
  for (const path of ['/notifications','/notifications/unread-count','/notification-rules','/push/subscriptions','/push/config','/push/status']) {
    assert.equal((await request(path)).status, 401); assert.equal((await request(path, { headers: { authorization: `Bearer ${f.workerToken}` } })).status, 401);
  }
  const page = await request('/notifications?limit=1', { cookie }); assert.equal(page.status, 200); assert.ok(page.data.nextCursor); assert.equal(page.data.items.length, 1);
  assert.equal(page.headers.get('cache-control'), 'no-store'); assert.equal(page.headers.get('x-content-type-options'), 'nosniff'); assert.ok(page.headers.get('x-request-id')); assert.ok(!JSON.stringify(page.data).includes('readme'));
  const id = page.data.items[0].id; assert.equal((await request(`/notifications/${id}`, { cookie })).data.notification.id, id);
  assert.equal((await request(`/notifications/${id}`, { method: 'PATCH', cookie, json: { read: true }, noOrigin: true })).status, 403);
  assert.equal((await request(`/notifications/${id}`, { method: 'PATCH', cookie, json: { read: true } })).data.notification.readAt !== null, true);
  assert.equal((await request('/notifications/unread-count', { cookie })).data.count, 1); assert.equal((await request('/notifications/read-all', { cookie, method: 'POST', json: {} })).data.count, 1);
  const created = await request('/notification-rules', { cookie, method: 'POST', json: { name: 'HTTP规则', eventTypes: ['changed'], keywords: ['example'] } }); assert.equal(created.status, 201);
  const ruleId = created.data.rule.id; assert.equal((await request(`/notification-rules/${ruleId}`, { cookie, method: 'PATCH', json: { enabled: false } })).data.rule.enabled, false);
  assert.equal((await request(`/notification-rules/${ruleId}`, { cookie, method: 'DELETE' })).status, 200);
  assert.equal((await request('/notifications?unread=bogus', { cookie })).status, 400);
});

test('真实HTTP设备元数据秘密隔离、test明确kind与幂等；logout仅解绑本设备且先验证归属再销毁session', async t => {
  const f = await httpFixture(t); const { request, cookie } = f; const other = await f.login(); const sub1 = device(); const sub2 = device();
  const first = await request('/push/subscriptions', { cookie, method: 'POST', json: { subscription: sub1, deviceLabel: '设备一' } }); const id1 = first.data.subscription.id;
  const second = await request('/push/subscriptions', { cookie: other, method: 'POST', json: { subscription: sub2, deviceLabel: '设备二' } }); const id2 = second.data.subscription.id;
  const metadata = await request('/push/subscriptions', { cookie }); const text = JSON.stringify(metadata.data);
  for (const secret of [sub1.endpoint, sub1.keys.auth, sub1.keys.p256dh, enabled.privateKey]) assert.ok(!text.includes(secret));
  assert.equal((await request('/push/test', { cookie, method: 'POST', json: {} })).data.error.code, 'INVALID_IDEMPOTENCY_KEY');
  assert.equal((await request('/push/test', { cookie, method: 'POST', json: { kind: 'changed' }, key: 'fake-business' })).data.error.code, 'INVALID_TEST_PUSH');
  const tested = await request('/push/test', { cookie, method: 'POST', json: { subscriptionId: id1 }, key: 'test-key' }); assert.equal(tested.status, 202); assert.equal(tested.data.notification.kind, 'test');
  const replay = await request('/push/test', { cookie, method: 'POST', json: { subscriptionId: id1 }, key: 'test-key' }); assert.equal(replay.data.notification.id, tested.data.notification.id); assert.equal(counts(f.store, 'notifications'), 1); assert.equal(counts(f.store, 'push_deliveries'), 1);
  assert.equal((await request('/push/test', { cookie, method: 'POST', json: { subscriptionId: id2 }, key: 'test-key' })).data.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await request('/push/test', { cookie, method: 'POST', json: { subscriptionId: id2 }, key: 'other-device' })).status, 403);
  await request('/push/test', { cookie: other, method: 'POST', json: { subscriptionId: id2 }, key: 'own-second' });
  const config = await request('/push/config', { cookie }); assert.deepEqual(Object.keys(config.data).sort(), ['configured','publicKey','enabled','reason'].sort()); assert.ok(!JSON.stringify(config.data).includes(enabled.privateKey));
  assert.equal((await request('/auth/logout', { cookie, method: 'POST', json: { subscriptionId: id2 } })).status, 403); assert.equal((await request('/auth/me', { cookie })).status, 200);
  assert.equal((await request('/auth/logout', { cookie, method: 'POST', json: { subscriptionId: id1 } })).status, 200); assert.equal((await request('/auth/me', { cookie })).status, 401);
  const remaining = await request('/push/subscriptions', { cookie: other }); assert.equal(remaining.data.items.length, 1); assert.equal(remaining.data.items[0].id, id2);
  assert.equal(delivery(f.store).find(row => row.subscription_id === id1).status, 'skipped'); assert.equal(delivery(f.store).find(row => row.subscription_id === id2).status, 'pending');
  assert.equal((await request(`/push/subscriptions/${id2}`, { cookie: other, method: 'DELETE' })).status, 200);
});

test('push disabled/未配置时站内与health正常，测试明确报错，status安全无外部网络依赖', async t => {
  for (const config of [{ enabled: false, configured: false, reason: 'PUSH_DISABLED' }, { enabled: true, configured: false, reason: 'PUSH_KEY_FILE_MISSING' }]) {
    let called = 0; const f = await httpFixture(t, config, { pushTransport: async () => { called++; throw new Error('network disconnected'); } }); const claim = start(f.store);
    ingest(f.store, claim, submission(claim.run, register(f.store, claim))); assert.equal((await f.request('/notifications', { cookie: f.cookie })).data.items.length, 1);
    assert.equal((await f.request('/health')).status, 200); assert.equal(f.clock.jobs.size, 0); assert.equal(called, 0);
    const registered = await f.request('/push/subscriptions', { cookie: f.cookie, method: 'POST', json: { subscription: device() } });
    const error = await f.request('/push/test', { cookie: f.cookie, method: 'POST', json: { subscriptionId: registered.data.subscription.id }, key: 'disabled-test' }); assert.equal(error.status, 409); assert.equal(error.data.error.code, config.enabled ? 'PUSH_NOT_CONFIGURED' : 'PUSH_DISABLED');
    const status = await f.request('/push/status', { cookie: f.cookie }); assert.equal(status.data.enabled, false); assert.equal(status.data.healthy, true); assert.equal(status.data.counts.pending, 0);
  }
});

test('真实HTTP外部push 503只让设备retry，不降级health或站内API；诊断无异常原文', async t => {
  const f = await httpFixture(t, enabled, { pushTransport: async () => { throw Object.assign(new Error('private endpoint secret details'), { statusCode: 503 }); } });
  enablePush(f.store.notifications); const registered = await f.request('/push/subscriptions', { cookie: f.cookie, method: 'POST', json: { subscription: device() } });
  await f.request('/push/test', { cookie: f.cookie, method: 'POST', json: { subscriptionId: registered.data.subscription.id }, key: 'network-unavailable' });
  await f.server.dispatcher.run(); assert.equal((await f.request('/health')).status, 200); assert.equal((await f.request('/notifications', { cookie: f.cookie })).status, 200);
  const status = await f.request('/push/status', { cookie: f.cookie }); assert.equal(status.data.healthy, true); assert.equal(status.data.counts.retry, 1); assert.equal(status.data.lastErrorCode, 'PUSH_SERVICE_UNAVAILABLE');
  assert.ok(!JSON.stringify(status.data).includes('private endpoint'));
});

test('自有数据库在sender结束后才关闭，忽略Abort的迟到transport不能回写已关闭DB', async t => {
  const [password, workerToken] = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  const auth = new Auth({ password, workerToken, publicOrigin: 'http://localhost:18082', secureCookie: false });
  let resolveNetwork; let databaseWasOpenOnAbort = false;
  const server = createServer({ filename: ':memory:', auth, pushConfig: enabled, dispatcherOptions: timers(), pushTransport: async ({ signal }) => {
    signal.addEventListener('abort', () => { databaseWasOpenOnAbort = server.dispatcher.notifications.db.prepare('SELECT 1 AS n').get().n === 1; });
    return new Promise(resolve => { resolveNetwork = resolve; });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const store = server.dispatcher.notifications.store; enablePush(store.notifications); store.notifications.registerDevice({ subscription: device() }, 'owner');
  const claim = start(store); ingest(store, claim, submission(claim.run, register(store, claim)));
  const sending = server.dispatcher.run(); await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => server.close(resolve)); await sending; assert.equal(databaseWasOpenOnAbort, true);
  assert.throws(() => store.db.prepare('SELECT 1'), /not open|closed/i);
  resolveNetwork({ statusCode: 201 }); await new Promise(resolve => setImmediate(resolve)); assert.equal(server.dispatcher.running, null);
});

test('真实HTTP server.close立即停止两timer并abort挂起sender，callback后可安全关闭注入DB', async t => {
  let signal; const f = await httpFixture(t, enabled, { pushTransport: async args => { signal = args.signal; return new Promise(() => {}); } });
  enablePush(f.store.notifications); f.store.notifications.registerDevice({ subscription: device() }, 'owner'); const claim = start(f.store); ingest(f.store, claim, submission(claim.run, register(f.store, claim)));
  const sending = f.server.dispatcher.run(); await new Promise(resolve => setImmediate(resolve));
  const closed = new Promise(resolve => f.server.close(resolve)); assert.equal(signal.aborted, true); assert.equal(f.clock.jobs.size, 0); await closed; await sending; assert.equal(f.server.dispatcher.running, null);
  assert.equal(delivery(f.store)[0].status, 'sending');
});
