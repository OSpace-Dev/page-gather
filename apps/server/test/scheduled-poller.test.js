import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerApi, WorkerPoller } from '../../worker/src/poller.js';
import { Controller } from '../../worker/src/controller.js';
import { Store } from '../store.js';
import { Auth } from '../auth.js';
import { createServer } from '../server.js';

// 真HTTP/SQLite/poller/controller/SDK与隔离spool；只有桌面与页面是合成fixture。
test('scheduled真实poller与人工互斥，计划修改不取消活动网页、不释放worker或profile锁', async t => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-poller-'));
  const actual = Date.now(); let now = actual - 86400000;
  const store = new Store({ filename: ':memory:', now: () => now });
  const [password, workerToken] = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  // 显式Store.tick驱动，测试不等待每日timer或改系统时间。
  const server = createServer({ store, auth: new Auth({ password, workerToken, publicOrigin: 'http://localhost:18080', secureCookie: false }), schedulerOptions: { setTimer: () => 1, clearTimer: () => {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  const api = new WorkerApi({ url: `http://127.0.0.1:${server.address().port}`, token: workerToken });
  let starts = 0; let stops = 0;
  const controller = new Controller({ desktop: { start: async () => { starts++; }, stop: async () => { stops++; } }, execute: async () => { throw new Error('UNEXPECTED_DESKTOP_EXECUTION'); } });
  const task = store.list('tasks').items[0];
  store.patchTask(task.id, { schedule: { enabled: true, time: new Date(actual).toISOString().slice(11,16), timezone: 'UTC' }, config: { maxRepos: 1, itemDelayMs: 3000 } });
  await controller.run({ command: 'manual-start' });
  now = actual; assert.equal(store.tick().created, 1); const run = store.list('runs').items[0];
  let navigations = 0; let unblock; let reached;
  const gate = new Promise(resolve => { unblock = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const withPage = async use => {
    assert.equal(controller.status().busy, true); assert.equal(controller.status().mode, 'PAUSED');
    reached(); await gate;
    return use({
      async navigate() { navigations++; return { status: 200 }; },
      async evaluateRead() { return navigations === 1 ? { url: 'https://github.com/trending?since=daily', listPresent: true, rows: [{ href: 'https://github.com/example/repo' }] } : { url: 'https://github.com/example/repo', repoPresent: true, readmePresent: true, text: '合成README', pageHref: 'https://github.com/example/repo#readme-ov-file' }; }
    });
  };
  const poller = new WorkerPoller({ controller, api, spoolRoot: root, withPage });
  await api.post('status', { workerId: 'worker-main', ...poller.status() });
  await poller.tick(); assert.equal(navigations, 0); assert.equal(store.run(run.id).status, 'QUEUED');
  await controller.run({ command: 'manual-finish' });
  await api.post('status', { workerId: 'worker-main', ...poller.status() });
  const running = poller.tick();
  try {
    await Promise.race([entered, running.then(() => { throw new Error('PAGE_EXPECTED'); })]);
    assert.equal(store.run(run.id).status, 'RUNNING');
    await assert.rejects(controller.run({ command: 'manual-start' }), /WORKER_BUSY/);
    store.patchTask(task.id, { enabled: false }); store.tick();
    assert.equal(controller.status().busy, true); assert.equal(store.run(run.id).cancelRequested, false);
    assert.equal(store.db.prepare('SELECT holder FROM profiles').get().holder, run.id);
  } finally { unblock(); }
  await running;
  assert.equal(store.run(run.id).status, 'SUCCEEDED'); assert.equal(navigations, 2);
  assert.equal(controller.status().busy, false); assert.equal(store.db.prepare('SELECT holder FROM profiles').get().holder, null);
  assert.equal(starts, 1); assert.equal(stops, 1, '只有manual-finish操作桌面，scheduler从不操作桌面');
  assert.equal((await poller.spool.pending()).length, 0);
});
