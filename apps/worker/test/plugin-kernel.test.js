import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlugin, MemoryCheckpointStore } from '../../../packages/plugin-sdk/index.js';

// 验证通用 collect(ctx) 可自由分支/循环，不依赖 GitHub 的队列结构。
function arbitrary(collect) {
  return { manifest: { id: 'fixture-flow', version: '1', engineApiVersion: '1' }, validateConfig: () => ({}), validateState: s => Array.isArray(s.pages), collect };
}
function options(extra = {}) {
  return { runId: 'kernel-test', collectionId: 'kernel-collection', collectionSeq: 1,
    deadline: new Date(Date.now() + 2000).toISOString(), store: new MemoryCheckpointStore(), ...extra };
}

test('内核支持插件自行分支、多页循环和原子 commit，不预设 list/detail', async () => {
  const visited = [];
  const plugin = arbitrary(async ctx => ctx.withPage(async page => {
    const pages = [];
    for (const branch of ['first', 'conditional', 'last']) {
      const value = await page.read(branch);
      if (value.include) pages.push(value.name);
    }
    await ctx.commit({ pages });
    return ctx.checkpoint.state;
  }));
  const result = await runPlugin(plugin, options({ withPage: async fn => fn({ read: async name => { visited.push(name); return { name, include: name !== 'conditional' }; } }) }));
  assert.deepEqual(visited, ['first', 'conditional', 'last']); assert.deepEqual(result.pages, ['first', 'last']);
});

test('内核取消进行中的读操作，后续插件步骤和 commit 不运行', async () => {
  const controller = new AbortController(); const store = new MemoryCheckpointStore(); let steps = 0; let hostSignal;
  const plugin = arbitrary(async ctx => ctx.withPage(async page => {
    await page.read(); steps++; await ctx.commit({ pages: ['bad'] });
  }));
  const run = runPlugin(plugin, options({ store, signal: controller.signal, withPage: async (fn, lease) => {
    hostSignal = lease.signal;
    return fn({ read: async () => { controller.abort(); return new Promise(() => {}); } });
  } }));
  await assert.rejects(run, /CANCELLED/); assert.equal(hostSignal.aborted, true); assert.equal(steps, 0);
  assert.equal((await store.load('kernel-test', 'kernel-collection')).state, null);
});

test('内核 deadline 拒绝永不返回的读操作，并通知宿主取消租约', async () => {
  let hostSignal;
  const plugin = arbitrary(async ctx => ctx.withPage(page => page.read()));
  await assert.rejects(runPlugin(plugin, options({ deadline: new Date(Date.now() + 40).toISOString(), withPage: async (fn, lease) => {
    hostSignal = lease.signal; return fn({ read: async () => new Promise(() => {}) });
  } })), /DEADLINE_EXCEEDED/);
  assert.equal(hostSignal.aborted, true);
});

test('没有显式页面租约或 engineApiVersion 不兼容，执行前拒绝', async () => {
  const plugin = arbitrary(() => { throw new Error('must not run'); });
  await assert.rejects(runPlugin(plugin, options()), /PAGE_LEASE_REQUIRED/);
  await assert.rejects(runPlugin({ ...plugin, manifest: { ...plugin.manifest, engineApiVersion: '2' } }, options()), /ENGINE_API_MISMATCH/);
});

test('通用 SDK 初次启动即持久绑定 deadline，无插件 commit 也不能放宽；缩短不 binding mismatch', async () => {
  let time = Date.parse('2026-06-01T12:00:00Z'); let leases = 0; let reads = 0;
  const original = time + 10000;
  const store = new MemoryCheckpointStore();
  const plugin = arbitrary(async ctx => ctx.withPage(async page => { await page.read(); return { ok: true }; }));
  const opts = options({ store, authorizeResume: async () => true, clock: { now: () => time }, deadline: new Date(original).toISOString(), withPage: async (fn, lease) => {
    leases++; assert.ok(lease.deadline <= original);
    return fn({ read: async () => { reads++; } });
  } });
  await runPlugin(plugin, opts);
  assert.equal((await store.load(opts.runId, opts.collectionId)).initialDeadline, original);
  await assert.rejects(runPlugin(plugin, { ...opts, authorizeResume: undefined }), /RESUME_AUTHORIZATION_REQUIRED/);
  await runPlugin(plugin, { ...opts, resume: true, deadline: new Date(original - 1000).toISOString() });
  await runPlugin(plugin, { ...opts, deadline: new Date(original + 100000).toISOString() });
  time = original;
  await assert.rejects(runPlugin(plugin, { ...opts, deadline: new Date(original + 100000).toISOString() }), /DEADLINE_EXCEEDED/);
  assert.equal(leases, 3); assert.equal(reads, 3);
});

test('通用 SDK 已 commit 恢复使用原 deadline 的租约和步骤检查，允许收紧', async () => {
  let time = Date.parse('2026-06-01T12:00:00Z'); const original = time + 10000; let reads = 0;
  const store = new MemoryCheckpointStore();
  const plugin = arbitrary(async ctx => {
    if (!ctx.checkpoint.state) { await ctx.commit({ pages: [] }); return { ok: true }; }
    return ctx.withPage(async page => { await page.navigate(); await page.read(); });
  });
  const opts = options({ store, clock: { now: () => time }, deadline: new Date(original).toISOString(), authorizeResume: async () => true,
    withPage: async (fn, lease) => {
      assert.equal(lease.deadline, original - 1000);
      return fn({ navigate: async () => { time = original - 1000; }, read: async () => { reads++; } });
    } });
  await runPlugin(plugin, opts);
  await assert.rejects(runPlugin(plugin, { ...opts, resume: true, deadline: new Date(original - 1000).toISOString() }), /DEADLINE_EXCEEDED/);
  assert.equal(reads, 0);
});
