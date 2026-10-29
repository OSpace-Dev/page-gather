import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { Scheduler } from '../scheduler.js';
import { createServer } from '../server.js';
import { Auth } from '../auth.js';
import { workerId, credentials, register, submission, ingest, start } from './helpers.js';

const config = (extra = {}) => ({ enabled: true, time: '09:00', timezone: 'UTC', ...extra });
function fixture(t, options = {}) {
  let now = Date.parse('2026-06-01T08:00Z');
  const store = new Store({ filename: ':memory:', now: () => now, ...options });
  t.after(() => store.close());
  return { store, task: store.list('tasks').items[0], at: time => { now = Date.parse(time); return now; }, now: () => now };
}
function enable(f, extra) { return f.store.patchTask(f.task.id, { schedule: config(extra) }); }
function claim(store, requestKey = randomUUID()) { return store.claim({ workerId, requestKey }); }
function manualMode(store, mode = 'MANUAL') { store.workerStatus({ workerId, mode, busy: false, activeRunId: null }); }

// 真SQLite + 可注入时钟；测试不启动浏览器或访问真实网站。
test('默认关闭；启用仅future，重复tick唯一SQL slot、自动快照与手动幂等不变', t => {
  const f = fixture(t); const { store, task } = f;
  assert.deepEqual(task.schedule, { enabled: false, time: '09:00', timezone: 'Asia/Shanghai' });
  assert.equal(task.nextScheduledAt, null); assert.equal(task.scheduleRevision, 1);
  assert.deepEqual(store.tick(f.at('2026-06-01T10:00Z')), { due: 0, created: 0, skipped: 0 });
  const enabled = enable(f); assert.equal(enabled.nextScheduledAt, '2026-06-02T09:00:00.000Z');
  const time = f.at('2026-06-02T09:00Z');
  assert.deepEqual(store.tick(time), { due: 1, created: 1, skipped: 0 });
  assert.deepEqual(store.tick(time), { due: 0, created: 0, skipped: 0 });
  const run = store.list('runs').items[0];
  assert.equal(run.trigger, 'scheduled'); assert.equal(run.scheduledFor, '2026-06-02T09:00:00.000Z');
  assert.equal(run.scheduleRevision, enabled.scheduleRevision); assert.equal(run.scheduledDate, '2026-06-02');
  assert.equal(run.taskSnapshot.schedule.timezone, 'UTC'); assert.equal(run.createdAt, run.scheduledFor);
  assert.throws(() => store.db.prepare('INSERT INTO runs(id,task_id,request_key,request_hash,doc,scheduled_for) VALUES(?,?,?,?,?,?)').run(randomUUID(), task.id, randomUUID(), 'hash', JSON.stringify(run), run.scheduledFor), /UNIQUE/);
  assert.throws(() => store.createRun(task.id, `/scheduled/${task.id}/${run.scheduledFor}`), e => e.code === 'INVALID_IDEMPOTENCY_KEY');
  const next = store.getTask(task.id).nextScheduledAt;
  const manual = store.createRun(task.id, 'stable-manual');
  assert.equal(manual.trigger, 'manual'); assert.equal(store.createRun(task.id, 'stable-manual').id, manual.id);
  assert.equal(store.getTask(task.id).nextScheduledAt, next);
});

test('非日程修改保留next和revision，新自动run使用最新参数；schedule/taskenabled编辑原子取消QUEUED', t => {
  const f = fixture(t); const { store, task } = f; const before = enable(f);
  assert.equal(store.patchTask(task.id, { schedule: { timezone: 'UTC', time: '09:00', enabled: true } }).scheduleRevision, before.scheduleRevision, '相同schedule字段顺序不同不修订');
  f.at('2026-06-01T08:30Z');
  const edit = store.patchTask(task.id, { name: '已更新', config: { maxRepos: 2 } });
  assert.equal(edit.nextScheduledAt, before.nextScheduledAt); assert.equal(edit.scheduleRevision, before.scheduleRevision);
  store.tick(f.at('2026-06-01T09:00Z')); const run = store.list('runs').items[0];
  assert.equal(run.name, '已更新'); assert.equal(run.config.maxRepos, 2);
  const manual = store.createRun(task.id, 'keep-manual');
  const changed = store.patchTask(task.id, { schedule: config({ time: '10:00' }) });
  assert.equal(changed.scheduleRevision, before.scheduleRevision + 1);
  assert.equal(changed.nextScheduledAt, '2026-06-01T10:00:00.000Z');
  assert.equal(store.run(run.id).status, 'SKIPPED'); assert.equal(store.run(run.id).error.code, 'SCHEDULE_CHANGED');
  assert.equal(store.run(manual.id).status, 'QUEUED');
  assert.equal(store.run(run.id).scheduledFor, '2026-06-01T09:00:00.000Z');
  store.cancel(manual.id);
  store.tick(f.at('2026-06-01T10:00Z')); const second = store.list('runs').items.at(-1);
  store.patchTask(task.id, { enabled: false });
  assert.equal(store.run(second.id).error.code, 'SCHEDULE_CHANGED'); assert.equal(store.getTask(task.id).nextScheduledAt, null);
  f.at('2026-06-04T11:00Z'); const resumed = store.patchTask(task.id, { enabled: true });
  assert.equal(resumed.nextScheduledAt, '2026-06-05T10:00:00.000Z');
  assert.equal(store.tick().created, 0);
  store.patchTask(task.id, { schedule: config({ enabled: false }) });
  assert.equal(store.getTask(task.id).nextScheduledAt, null);
  f.at('2026-06-08T12:00Z'); assert.equal(enable(f).nextScheduledAt, '2026-06-09T09:00:00.000Z');
});

test('修改计划不取消RUNNING、不释放档案锁；旧claim ticket不再执行已停的run', t => {
  const f = fixture(t); const { store, task } = f; enable(f);
  store.tick(f.at('2026-06-01T09:00Z')); const ticket = 'scheduled-ticket'; const c = claim(store, ticket);
  store.patchTask(task.id, { schedule: config({ enabled: false }) });
  assert.equal(store.run(c.run.id).status, 'RUNNING'); assert.equal(store.db.prepare('SELECT holder FROM profiles').get().holder, c.run.id);
  assert.equal(claim(store, ticket).action, 'finalize_only'); // 不撤销RUNNING，但旧ticket不得授权重新执行网页。
  assert.throws(() => store.outcome(c.run.id, { ...credentials(c), status: 'SKIPPED' }), e => e.code === 'INVALID_OUTCOME');
  store.outcome(c.run.id, { ...credentials(c), status: 'FAILED', errorCode: 'READ_FAILED' });
  const replay = claim(store, ticket); assert.equal(replay.action, 'finalize_only'); assert.equal(replay.run.id, c.run.id);
  assert.equal(store.db.prepare('SELECT holder FROM profiles').get().holder, null);
});

test('task同有QUEUED/RUNNING/RECOVERING时不创建run，仅TASK_ACTIVE摘要与next原子推进', t => {
  for (const status of ['QUEUED', 'RUNNING', 'RECOVERING']) {
    let now = Date.parse('2026-06-01T08:00Z');
    const store = new Store({ filename: ':memory:', now: () => now });
    try {
      const task = store.list('tasks').items[0]; store.patchTask(task.id, { schedule: config() });
      now = Date.parse('2026-06-01T08:59:30Z');
      const manual = store.createRun(task.id, randomUUID());
      if (status !== 'QUEUED') { const c = claim(store); if (status === 'RECOVERING') { const run = store.run(c.run.id); run.status = 'RECOVERING'; store.saveRun(run); } }
      const originalRuns = store.list('runs').items;
      const profile = store.db.prepare('SELECT * FROM profiles').get();
      const before = store.getTask(task.id); const dueAt = Date.parse('2026-06-01T09:00Z');
      store.db.exec("CREATE TRIGGER fail_occupied BEFORE UPDATE ON schedules BEGIN SELECT RAISE(ABORT,'occupied rollback'); END");
      assert.throws(() => store.tick(dueAt), /occupied rollback/);
      assert.deepEqual(store.getTask(task.id), before, '占用摘要与next推进失败一起回滚');
      assert.deepEqual(store.list('runs').items, originalRuns);
      assert.deepEqual(store.db.prepare('SELECT * FROM profiles').get(), profile);
      store.db.exec('DROP TRIGGER fail_occupied');
      assert.deepEqual(store.tick(dueAt), { due: 1, created: 0, skipped: 1 });
      assert.equal(store.list('runs').items.length, 1, '占用slot不创建任何run');
      assert.deepEqual(store.list('runs').items, originalRuns, '原run所有字段不变');
      assert.equal(store.run(manual.id).status, status);
      assert.deepEqual(store.db.prepare('SELECT * FROM profiles').get(), profile);
      assert.equal(store.db.prepare('SELECT id FROM runs WHERE task_id=? AND scheduled_for=?').get(task.id, '2026-06-01T09:00:00.000Z'), undefined);
      const after = store.getTask(task.id);
      assert.equal(after.nextScheduledAt, '2026-06-02T09:00:00.000Z');
      assert.equal(after.lastScheduledFor, '2026-06-01T09:00:00.000Z');
      assert.deepEqual(after.scheduleStatus, { state: 'SCHEDULED', created: 0, skipped: 1, lastReason: 'TASK_ACTIVE' });
      assert.deepEqual(store.tick(dueAt), { due: 0, created: 0, skipped: 0 });
      assert.deepEqual(store.getTask(task.id), after, '重复tick不重复累计摘要');
    } finally { store.close(); }
  }
});

test('MANUAL/离线允许至多一个自动QUEUED，过期先SKIPPED不网页、不释放已有锁', t => {
  const f = fixture(t); const { store } = f; enable(f); manualMode(store);
  store.tick(f.at('2026-06-01T09:00Z')); const queued = store.list('runs').items[0];
  assert.equal(claim(store), null);
  f.at('2026-06-02T09:00Z'); manualMode(store);
  const originalRuns = store.list('runs').items;
  const stats = store.tick(); assert.equal(stats.created, 0); assert.equal(stats.skipped, 1);
  assert.deepEqual(store.list('runs').items, originalRuns, '已有自动QUEUED占用时也只计摘要，不创建SKIPPED run');
  assert.equal(store.getTask(f.task.id).nextScheduledAt, '2026-06-03T09:00:00.000Z');
  assert.deepEqual(store.getTask(f.task.id).scheduleStatus, { state: 'SCHEDULED', created: 1, skipped: 1, lastReason: 'TASK_ACTIVE' });
  assert.equal(store.list('runs').items.filter(r => r.status === 'QUEUED').length, 1);
  // 24小时边界内旧队列仍有效；过界领取即SKIPPED。
  f.at('2026-06-02T09:00:00.001Z'); manualMode(store, 'AUTO');
  assert.equal(claim(store), null); assert.equal(store.run(queued.id).error.code, 'SCHEDULE_EXPIRED');
  assert.equal(store.run(queued.id).status, 'SKIPPED'); assert.equal(store.list('runs').items.every(r => r.attempt === 0), true);
  store.tick(f.at('2026-06-03T09:00Z')); const offline = store.list('runs').items.at(-1);
  assert.equal(offline.status, 'QUEUED'); assert.equal(claim(store), null, 'worker心跳超过90秒不可执行');
  manualMode(store, 'AUTO'); assert.equal(claim(store).run.id, offline.id);
});

test('claim前核验revision/disabled/24小时，跳过无效队列后还能领取manual；精确24小时仍可领', t => {
  for (const reason of ['SCHEDULE_CHANGED', 'SCHEDULE_DISABLED', 'SCHEDULE_EXPIRED']) {
    const f = fixture(t); const { store, task } = f; enable(f); store.tick(f.at('2026-06-01T09:00Z'));
    const run = store.list('runs').items[0];
    // 模拟旧队列/恢复记录，避免依赖PATCH主动取消来掩盖claim核验。
    if (reason === 'SCHEDULE_CHANGED') { run.scheduleRevision--; store.saveRun(run); }
    if (reason === 'SCHEDULE_DISABLED') store.db.prepare("UPDATE schedules SET config=json_set(config,'$.enabled',json('false')) WHERE task_id=?").run(task.id);
    if (reason === 'SCHEDULE_EXPIRED') f.at('2026-06-02T09:00:00.001Z');
    const manual = store.createRun(task.id, randomUUID());
    assert.equal(claim(store).run.id, manual.id); assert.equal(store.run(run.id).status, 'SKIPPED'); assert.equal(store.run(run.id).error.code, reason);
    assert.equal(store.run(run.id).attempt, 0);
  }
  const f = fixture(t); enable(f); f.store.tick(f.at('2026-06-01T09:00Z')); f.at('2026-06-02T09:00Z');
  assert.equal(claim(f.store).action, 'execute');
});

test('自动claim ticket replay复核过期/旧revision/禁用，不改变manual replay或释放RUNNING锁', t => {
  for (const reason of ['SCHEDULE_CHANGED', 'SCHEDULE_DISABLED', 'SCHEDULE_EXPIRED']) {
    const f = fixture(t); const { store, task } = f; enable(f); store.tick(f.at('2026-06-01T09:00Z'));
    const ticket = randomUUID(); const c = claim(store, ticket);
    if (reason === 'SCHEDULE_CHANGED') store.patchTask(task.id, { schedule: config({ time: '10:00' }) });
    if (reason === 'SCHEDULE_DISABLED') store.patchTask(task.id, { enabled: false });
    if (reason === 'SCHEDULE_EXPIRED') {
      // 将有效lease保留到24h外，证明不是普通lease过期检查挡住replay。
      f.at('2026-06-02T09:00:00.001Z');
      const lease = { ...c.lease, leaseUntil: '2026-06-02T09:02:00.000Z' };
      store.db.prepare('UPDATE claims SET lease=? WHERE request_key=?').run(JSON.stringify(lease), ticket);
      const run = store.run(c.run.id); run.leaseUntil = lease.leaseUntil; store.saveRun(run);
    }
    const replay = claim(store, ticket);
    assert.equal(replay.action, 'finalize_only'); assert.equal(replay.run.id, c.run.id); assert.equal(replay.replayed, true);
    assert.equal(store.run(c.run.id).status, 'RUNNING'); assert.equal(store.db.prepare('SELECT holder FROM profiles').get().holder, c.run.id);
    assert.equal(store.scheduledRunReason(replay.run), reason);
  }
  const f = fixture(t); const manual = start(f.store); const ticket = f.store.db.prepare('SELECT request_key FROM claims WHERE run_id=?').get(manual.run.id).request_key;
  f.store.patchTask(f.task.id, { enabled: false });
  assert.equal(claim(f.store, ticket).action, 'execute', 'manual replay沿用P2，不套用日程enabled核验');
});

test('日程改回同一UTC slot不能重建，无论revision/旧run已SKIPPED', t => {
  const f = fixture(t); enable(f); f.store.tick(f.at('2026-06-01T09:00Z'));
  f.at('2026-06-01T08:30Z'); // 隔离假时钟模拟修订时UTC slot再次进入未来。
  f.store.patchTask(f.task.id, { schedule: config({ time: '10:00' }) }); enable(f);
  assert.equal(f.store.tick(f.at('2026-06-01T09:00Z')).skipped, 1);
  assert.equal(f.store.list('runs').items.length, 1);
  assert.equal(f.store.getTask(f.task.id).scheduleStatus.lastReason, 'SCHEDULE_DUPLICATE');
});

test('真实文件SQLite重启只补最新24h一次，十年积压只保存摘要，重复重启不增加run', t => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-restart-')); const filename = join(dir, 'test.sqlite');
  let now = Date.parse('2016-06-01T08:00Z'); let store = new Store({ filename, now: () => now });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const task = store.list('tasks').items[0]; store.patchTask(task.id, { schedule: config() }); store.close();
  now = Date.parse('2026-06-01T08:00Z'); store = new Store({ filename, now: () => now });
  const stats = store.tick(); assert.equal(stats.created, 1); assert.equal(stats.skipped, 3651);
  assert.equal(store.list('runs').items.length, 1); assert.equal(store.list('runs').items[0].scheduledFor, '2026-05-31T09:00:00.000Z');
  assert.equal(store.getTask(task.id).nextScheduledAt, '2026-06-01T09:00:00.000Z');
  store.close(); store = new Store({ filename, now: () => now });
  assert.equal(store.tick().created, 0); assert.equal(store.list('runs').items.length, 1);
  assert.equal(store.getTask(task.id).scheduleStatus.skipped, 3651);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('24h窗口含DST回拨25小时，窗口外不创建run、不逐日补；春季23小时选最近slot', t => {
  const f = fixture(t); const { store } = f;
  f.at('2026-10-31T04:00Z'); enable(f, { timezone: 'America/New_York', time: '01:30' });
  assert.equal(store.tick(f.at('2026-11-02T06:15Z')).created, 0);
  assert.equal(store.list('runs').items.length, 0); assert.equal(store.getTask(f.task.id).scheduleStatus.lastReason, 'SCHEDULE_EXPIRED');
  assert.equal(store.getTask(f.task.id).nextScheduledAt, '2026-11-02T06:30:00.000Z');
  f.at('2027-03-13T04:00Z'); enable(f, { timezone: 'America/New_York', time: '02:30' });
  store.tick(f.at('2027-03-14T07:30Z'));
  assert.equal(store.list('runs').items[0].scheduledFor, '2027-03-14T07:00:00.000Z');
});

test('run创建+next推进同事务；task编辑+取消同事务：故障全回滚可重试', t => {
  const f = fixture(t); const { store, task } = f; const before = enable(f); f.at('2026-06-01T09:00Z');
  store.db.exec("CREATE TRIGGER fail_advance BEFORE UPDATE ON schedules BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  assert.throws(() => store.tick(), /test rollback/);
  assert.equal(store.list('runs').items.length, 0); assert.equal(store.getTask(task.id).nextScheduledAt, before.nextScheduledAt);
  store.db.exec('DROP TRIGGER fail_advance'); assert.equal(store.tick().created, 1);
  const run = store.list('runs').items[0];
  store.db.exec("CREATE TRIGGER fail_cancel BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'cancel rollback'); END");
  assert.throws(() => store.patchTask(task.id, { name: 'rollback', schedule: config({ enabled: false }) }), /cancel rollback/);
  assert.equal(store.getTask(task.id).name, task.name); assert.equal(store.getTask(task.id).schedule.enabled, true);
  assert.equal(store.getTask(task.id).scheduleRevision, before.scheduleRevision); assert.equal(store.run(run.id).status, 'QUEUED');
  store.db.exec('DROP TRIGGER fail_cancel');
  store.db.exec("CREATE TRIGGER fail_create BEFORE INSERT ON schedules BEGIN SELECT RAISE(ABORT,'create rollback'); END");
  assert.throws(() => store.createTask({ name: 'rollback', pluginId: task.pluginId, pluginVersion: task.pluginVersion, config: {} }), /create rollback/);
  assert.equal(store.list('tasks').items.length, 1);
});

test('P2数据库迁移不重置结果、收据、claims、档案锁；所有旧task日程关闭', t => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-migrate-')); const filename = join(dir, 'test.sqlite');
  let store = new Store({ filename }); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const c = start(store); const s = submission(c.run, register(store, c)); const receipt = ingest(store, c, s);
  const taskId = c.run.taskId; const claims = store.db.prepare('SELECT * FROM claims').all();
  store.db.exec('DROP TABLE schedules; DROP INDEX runs_slot; ALTER TABLE runs DROP COLUMN scheduled_for; PRAGMA user_version=2');
  const task = JSON.parse(store.db.prepare('SELECT doc FROM tasks WHERE id=?').get(taskId).doc); delete task.schedule;
  store.db.prepare('UPDATE tasks SET doc=? WHERE id=?').run(JSON.stringify(task), taskId);
  store.close(); store = new Store({ filename });
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(store.getTask(taskId).schedule.enabled, false); assert.equal(store.getTask(taskId).nextScheduledAt, null);
  assert.equal(store.run(c.run.id).status, 'RECOVERING'); assert.equal(store.db.prepare('SELECT holder FROM profiles').get().holder, c.run.id);
  assert.deepEqual(store.db.prepare('SELECT * FROM claims').all(), claims);
  assert.deepEqual(store.getRun(c.run.id).result, s.payload);
  assert.deepEqual(store.submit(c.run.id, { workerId, submission: s }).receipt, receipt);
  assert.equal(store.tick().created, 0); assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

function timers() {
  let id = 0; const pending = new Map();
  return { pending, setTimer: (fn, delay) => { const n = ++id; pending.set(n, { fn, delay }); return n; }, clearTimer: n => pending.delete(n), fire: () => { const [n, timer] = pending.entries().next().value; pending.delete(n); timer.fn(); return timer.delay; } };
}

test('低CPU最近到期/60s兜底、patch/create唤醒、异常退避/health失败、恢复与stop无残余timer', t => {
  const f = fixture(t); const clock = timers(); const errors = [];
  const scheduler = new Scheduler(f.store, { ...clock, onError: code => errors.push(code) }); t.after(() => scheduler.stop()); scheduler.start();
  assert.equal(clock.pending.size, 1); assert.equal([...clock.pending.values()][0].delay, 60000); assert.equal(scheduler.status().healthy, true);
  f.at('2026-06-01T08:59:30Z'); enable(f); assert.equal([...clock.pending.values()][0].delay, 0);
  clock.fire(); assert.equal([...clock.pending.values()][0].delay, 30000);
  f.store.createTask({ name: 'wake', pluginId: f.task.pluginId, pluginVersion: f.task.pluginVersion }); assert.equal([...clock.pending.values()][0].delay, 0); clock.fire();
  const tick = f.store.tick.bind(f.store); f.store.tick = () => { throw new Error('private fixture error must not appear'); };
  clock.fire(); assert.equal(scheduler.status().healthy, false); assert.equal(scheduler.status().lastErrorCode, 'SCHEDULER_TICK_FAILED'); assert.equal([...clock.pending.values()][0].delay, 1000);
  enable(f); assert.equal([...clock.pending.values()][0].delay, 1000, '配置写入不绕过错误退避');
  clock.fire(); assert.equal([...clock.pending.values()][0].delay, 2000); assert.equal(errors.length, 2);
  f.store.tick = tick; f.at('2026-06-01T09:00Z'); clock.fire();
  assert.equal(scheduler.status().healthy, true); assert.equal(scheduler.status().lastErrorCode, null); assert.equal(scheduler.status().stats.created, 1);
  scheduler.stop(); assert.equal(clock.pending.size, 0); assert.equal(scheduler.status().nextWakeAt, null); assert.equal(f.store.onScheduleChange, null);
});

test('HTTP admin scheduler、public安全summary、输入400、假时钟tick和server.close先停timer', async t => {
  const f = fixture(t); const clock = timers(); const origin = 'http://localhost:18080';
  const [password, workerToken] = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  const auth = new Auth({ password, workerToken, publicOrigin: origin, secureCookie: false });
  const server = createServer({ store: f.store, auth, schedulerOptions: { ...clock, onError: () => {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const login = await fetch(base + '/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = async (path, headers = {}) => { const response = await fetch(base + path, { headers }); return { status: response.status, data: await response.json() }; };
  assert.equal((await get('/scheduler')).status, 401); assert.equal((await get('/scheduler', { authorization: `Bearer ${workerToken}` })).status, 401);
  const state = await get('/scheduler', { cookie }); assert.equal(state.status, 200);
  assert.deepEqual(Object.keys(state.data).sort(), ['enabled','healthy','lastTickAt','lastErrorCode','nextWakeAt','stats'].sort());
  assert.deepEqual(state.data.stats, { due: 0, created: 0, skipped: 0 });
  assert.deepEqual((await get('/health')).data, { status: 'ok', scheduler: { enabled: true, healthy: true } });
  const patch = async schedule => {
    const response = await fetch(`${base}/tasks/${f.task.id}`, { method: 'PATCH', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ schedule }) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await patch(config({ timezone: 'invalid' }))).status, 400); assert.equal((await patch(config({ time: '25:00' }))).status, 400);
  const saved = await patch(config()); assert.equal(saved.status, 200); assert.equal(saved.data.task.nextScheduledAt, '2026-06-01T09:00:00.000Z');
  f.at('2026-06-01T09:00Z'); clock.fire(); assert.equal((await get('/scheduler', { cookie })).data.stats.created, 1);
  assert.equal((await get('/tasks', { cookie })).data.items[0].scheduleRevision, saved.data.task.scheduleRevision);
  const original = f.store.tick; f.store.tick = () => { throw new Error('private sql/path'); }; clock.fire();
  const health = await get('/health'); assert.equal(health.status, 503); assert.deepEqual(health.data, { status: 'degraded', scheduler: { enabled: true, healthy: false } });
  assert.equal((await get('/scheduler', { cookie })).data.lastErrorCode, 'SCHEDULER_TICK_FAILED'); f.store.tick = original;
  assert.equal((await get('/scheduler/tick?now=0', { cookie })).status, 404);
  const closed = new Promise(resolve => server.close(resolve)); assert.equal(clock.pending.size, 0, 'close调用即停止timer，不等HTTP连接结束'); await closed;
});
