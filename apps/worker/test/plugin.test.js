import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { checkSchema } from './helpers/schema.js';
import { MemoryCheckpointStore, JsonCheckpointStore, runPlugin, sealPluginResult, readOpenDraft, readSealedSubmission, createLimiter, checkpoint, fail, hash, canonical, DEFAULT_CHECKPOINT_MAX_BYTES } from '../../../packages/plugin-sdk/index.js';
import { withCdpPage } from '../../../packages/plugin-sdk/cdp-page.js';
import plugin, { contentHash, repository, validateConfig } from '../../../plugins/github-trending/index.js';
const fixture = JSON.parse(await readFile(new URL('./fixtures/plugin-github-dom.json', import.meta.url)));

// DOM fixture 运行插件实际编译的读取表达式，模拟选择器/属性/innerText；不替换 collect 或其数据提取函数。
function documentFor(data, list) {
  const root = data.missing ? null : {
    querySelector(selector) {
      if (selector === 'article.markdown-body, .markdown-body') return data.noArticle ? null : { innerText: data.text };
      throw new Error(`UNKNOWN_ROOT_SELECTOR ${selector}`);
    },
    querySelectorAll(selector) {
      assert.equal(selector, 'a[href*="/blob/"]');
      return [...(data.bodyHref ? [{ href: data.bodyHref, body: true }] : []), ...(data.fileHref ? [{ href: data.fileHref }] : [])].map(link => ({
        getAttribute: () => link.href,
        closest: selector => selector === 'article, .markdown-body' ? (link.body ? {} : null) : (link.body ? null : {})
      }));
    }
  };
  return {
    title: data.challenge ? 'Verify you are human' : 'GitHub',
    querySelector(selector) {
      if (selector === '#readme') return root;
      if (selector === '#repo-content-pjax-container .git-empty') return data.emptyRepository ? { innerText: 'Quick setup — get started', querySelector: () => ({}) } : null;
      if (selector.includes('#challenge-running')) return null;
      if (selector === '.explore-pjax-container, [data-hpc], main') return list ? {} : null;
      if (selector.startsWith('[itemprop="name"]')) return list || data.notRepo ? null : {};
      throw new Error(`UNKNOWN_DOCUMENT_SELECTOR ${selector}`);
    },
    querySelectorAll(selector) {
      if (selector === 'nav[aria-label="Repository files"]' || selector === 'a[href="#readme-ov-file"]') return [];
      assert.equal(selector, 'article.Box-row');
      return data.rows.map(entry => {
        const row = typeof entry === 'string' ? { href: entry } : entry;
        return { querySelector(selector) {
          if (selector === 'h2 a') return { getAttribute: () => row.href };
          const field = { p: 'description', '[itemprop="programmingLanguage"]': 'language', 'a[href$="/stargazers"]': 'stars', '.float-sm-right': 'dailyChange' }[selector];
          assert.ok(field); return row[field] == null ? null : { innerText: row[field] };
        } };
      });
    }
  };
}
function setup({ store = new MemoryCheckpointStore(), config = {}, behavior, data = structuredClone(fixture) } = {}) {
  let time = Date.parse('2026-06-01T12:00:00Z');
  let current; let list;
  const calls = []; const logs = []; const waits = [];
  const clock = { now: () => time, sleep: async (ms, signal) => { if (signal?.aborted) throw fail('CANCELLED'); waits.push(ms); time += ms; } };
  const page = {
    async navigate(url) {
      calls.push({ url, at: time });
      const response = await behavior?.(url, calls.length);
      if (response instanceof Error) throw response;
      list = new URL(url).pathname.startsWith('/trending');
      current = list ? data.list : data.repos[url];
      assert.ok(current, `Unexpected navigation: ${url}`);
      return response ?? { status: 200 };
    },
    async evaluateRead(expression) {
      return runInNewContext(expression, { document: documentFor(current, list), location: { href: current.url }, URL });
    }
  };
  const options = { runId: 'run-fixture', collectionId: 'collection-fixture', collectionSeq: 7,
    deadline: '2026-06-01T23:00:00Z', config, store, clock, limiter: createLimiter(),
    withPage: async fn => fn(page), authorizeResume: async () => true, progress: entry => logs.push(entry) };
  return { options, store, calls, logs, waits, data, clock, setTime: value => { time = value; },
    run: extra => runPlugin(plugin, { ...options, ...extra }) };
}

test('插件拥有顺序列表/逐项流程，所有请求遵守间隔；渲染纯文本与真实文件链接', async () => {
  const h = setup(); const result = await h.run();
  assert.equal(result.completeness, 'complete'); assert.equal(result.items.length, 3);
  assert.deepEqual(h.calls.map(c => new URL(c.url).pathname), ['/trending', '/Alpha/One', '/Beta/Two', '/Gamma/Three']);
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].at - h.calls[i - 1].at >= 5000);
  const [first, missing] = result.items;
  assert.equal(first.sourceKey, 'alpha/renamed');
  assert.equal(first.readme.sourceUrl, 'https://github.com/Alpha/Renamed/blob/release-v2/docs/README.rst');
  assert.equal(first.readme.format, 'rendered_text'); assert.equal(first.readme.truncated, null); assert.equal(first.readme.text, fixture.repos['https://github.com/Alpha/One'].text);
  assert.equal(first.readme.sourceKind, 'file'); assert.equal(first.readme.fileSourceUrl, first.readme.sourceUrl);
  assert.equal(missing.readme.status, 'not_found'); assert.equal(missing.readme.sourceUrl, null);
  assert.equal(missing.readme.sourceKind, null); assert.equal(missing.readme.fileSourceUrl, null);
  assert.equal(result.observedAt, '2026-06-01T12:00:00.000Z'); assert.equal(result.capturedDate, '2026-06-01');
  assert.ok(h.logs.every(e => Object.keys(e).join(',') === 'itemKey,code'));
  assert.equal(JSON.stringify(h.logs).includes('README'), false);
});

test('第二项失败保留第一项；resume 不重读榜单、不重抓第一项，固定 queue/seq', async () => {
  let failed = false;
  const h = setup({ behavior: url => { if (url.endsWith('/Beta/Two') && !failed) { failed = true; return fail('NETWORK_TRANSIENT'); } } });
  const partial = await h.run();
  assert.equal(partial.completeness, 'partial'); assert.equal(partial.items.length, 1);
  h.data.list.rows = ['/Other/New'];
  const result = await h.run({ resume: true });
  assert.equal(result.completeness, 'complete'); assert.equal(result.collectionSeq, 7);
  assert.deepEqual(h.calls.map(c => new URL(c.url).pathname), ['/trending', '/Alpha/One', '/Beta/Two', '/Beta/Two', '/Gamma/Three']);
  assert.deepEqual(result.items[0], partial.items[0]);
  assert.equal(result.items[2].sourceKey, 'gamma/three');
});

test('OPEN 续采必须宿主授权；SEALED partial 固定 submission，只能读取重传', async () => {
  let failed = false;
  const h = setup({ behavior: url => { if (url.endsWith('/Beta/Two') && !failed) { failed = true; return fail('READ_TIMEOUT'); } } });
  const draft = await h.run(); assert.equal(draft.checkpoint.phase, 'OPEN');
  const count = h.calls.length;
  await assert.rejects(h.run({ authorizeResume: undefined }), /RESUME_AUTHORIZATION_REQUIRED/);
  await assert.rejects(h.run({ authorizeResume: async request => {
    assert.equal(request.binding.collectionSeq, 7); assert.equal(request.state.capturedDate, '2026-06-01');
    return false; // 模拟中心发现更新 collection/水位、失去独占或租约。
  } }), /RESUME_NOT_AUTHORIZED/);
  assert.equal(h.calls.length, count);
  const submission = await sealPluginResult(plugin, h.options, draft);
  assert.equal(submission.payload.completeness, 'partial'); assert.equal(submission.payload.items.length, 1);
  assert.equal(submission.payloadHash, hash(submission.payload));
  assert.deepEqual(await sealPluginResult(plugin, h.options, draft), submission);
  await assert.rejects(h.run({ resume: true }), /COLLECTION_SEALED/);
  assert.deepEqual(await readSealedSubmission(plugin, h.options), submission);
  const altered = structuredClone(draft); altered.items = [];
  await assert.rejects(sealPluginResult(plugin, h.options, altered), /SEALED_PAYLOAD_MISMATCH/);
  assert.equal(h.calls.length, count);
  h.setTime(Date.parse('2026-06-03T00:00:00Z'));
  assert.deepEqual(await readSealedSubmission(plugin, h.options), submission); // 过期仍可取原封存包供归档/重传。
});

test('旧草稿不能封存新状态，seal 写失败仍保留 OPEN，可重试封存', async () => {
  let failed = false;
  const h = setup({ behavior: url => { if (url.endsWith('/Beta/Two') && !failed) { failed = true; return fail('READ_TIMEOUT'); } } });
  const partial = await h.run(); const complete = await h.run({ resume: true });
  await assert.rejects(sealPluginResult(plugin, h.options, partial), /DRAFT_CHANGED/);
  const save = h.store.save.bind(h.store);
  h.store.save = async () => { throw fail('CHECKPOINT_WRITE_FAILED'); };
  await assert.rejects(sealPluginResult(plugin, h.options, complete), /CHECKPOINT_WRITE_FAILED/);
  assert.equal((await h.store.load('run-fixture', 'collection-fixture')).phase, 'OPEN');
  h.store.save = save;
  const sealed = await sealPluginResult(plugin, h.options, complete); assert.equal(sealed.payload.completeness, 'complete');
  assert.equal((await h.store.load('run-fixture', 'collection-fixture')).phase, 'SEALED');
});

test('重试预算跨 resume 至多一次，失败项不 completed', async () => {
  const h = setup({ behavior: url => url.endsWith('/Beta/Two') ? fail('READ_TIMEOUT') : undefined });
  await h.run(); await h.run({ resume: true }); await h.run({ resume: true });
  assert.equal(h.calls.filter(c => c.url.endsWith('/Beta/Two')).length, 2);
  const state = (await h.store.load('run-fixture', 'collection-fixture')).state;
  assert.deepEqual(state.items.map(i => i.queueKey), ['alpha/one', 'gamma/three']);
  assert.deepEqual(state.terminalItemFailures, ['beta/two']);
});

test('冻结后 config/plugin/collection/seq 绑定不符拒绝，缺失 resume 不重新采集', async () => {
  const h = setup(); await h.run(); const count = h.calls.length;
  await assert.rejects(h.run({ config: { maxRepos: 2 } }), /CHECKPOINT_BINDING_MISMATCH/);
  await assert.rejects(runPlugin({ ...plugin, manifest: { ...plugin.manifest, version: '0.2.0' } }, h.options), /CHECKPOINT_BINDING_MISMATCH/);
  await assert.rejects(h.run({ collectionSeq: 8 }), /CHECKPOINT_BINDING_MISMATCH/);
  const doc = await h.store.load('run-fixture', 'collection-fixture');
  await h.store.save('run-fixture', 'another-collection', doc);
  await assert.rejects(h.run({ collectionId: 'another-collection', resume: true }), /CHECKPOINT_BINDING_MISMATCH/);
  await assert.rejects(h.run({ collectionId: 'absent-collection', resume: true }), /CHECKPOINT_NOT_FOUND/);
  assert.equal(h.calls.length, count);
});

test('取消当前 item 不标完成、不吞异常、不重试，保留已完成项', async () => {
  const controller = new AbortController();
  const h = setup({ behavior: url => { if (url.endsWith('/Beta/Two')) { controller.abort(); return fail('NETWORK_TRANSIENT'); } } });
  await assert.rejects(h.run({ signal: controller.signal }), /CANCELLED/);
  const state = (await h.store.load('run-fixture', 'collection-fixture')).state;
  assert.deepEqual(state.items.map(i => i.queueKey), ['alpha/one']);
  assert.equal(state.attempts['beta/two'], 1); assert.deepEqual(state.errors, []);
  assert.equal(h.calls.length, 3);
  const draft = await readOpenDraft(plugin, h.options); // 取消后仅从 spool 读取可封存的 partial，不访问页面。
  assert.equal(draft.items.length, 1); assert.equal(draft.completeness, 'partial');
  const sealed = await sealPluginResult(plugin, h.options, draft);
  assert.equal(sealed.payload.items.length, 1); assert.equal(h.calls.length, 3);
});

test('wait 可中断；deadline 不转成普通失败；跨天/原 deadline 过期 resume 拒绝', async () => {
  const h = setup();
  await assert.rejects(h.run({ deadline: '2026-06-01T12:00:03Z' }), /DEADLINE_EXCEEDED/);
  assert.equal(h.calls.length, 1);
  h.setTime(Date.parse('2026-06-02T00:00:00Z'));
  await assert.rejects(h.run({ deadline: '2026-06-02T22:00:00Z', resume: true }), /DEADLINE_EXCEEDED/);
  assert.equal(h.calls.length, 1);
  const controller = new AbortController();
  const micro = { manifest: { id: 'wait-test', version: '1', engineApiVersion: '1' }, validateConfig: () => ({}), validateState: () => true,
    collect: async ctx => { const wait = ctx.wait(10000); controller.abort(); await wait; } };
  await assert.rejects(runPlugin(micro, { ...h.options, store: new MemoryCheckpointStore(), clock: undefined, deadline: new Date(Date.now() + 20000).toISOString(), signal: controller.signal }), /CANCELLED/);
});

test('403/429/挑战停止后续和 resume，RetryAfter 约束共享全局限速器', async () => {
  for (const kind of [403, 429, 'challenge']) {
    const h = setup({ behavior: url => url.endsWith('/Beta/Two') && kind !== 'challenge' ? { status: kind, retryAfter: '60' } : undefined });
    if (kind === 'challenge') h.data.repos['https://github.com/Beta/Two'].challenge = true;
    const result = await h.run(); assert.equal(result.items.length, 1); assert.equal(result.completeness, 'partial');
    assert.equal(result.errors[0].code, kind === 403 ? 'ACCESS_DENIED' : kind === 429 ? 'RATE_LIMITED' : 'CHALLENGE_REQUIRED');
    const count = h.calls.length; await h.run({ resume: true }); assert.equal(h.calls.length, count);
    if (kind === 429) {
      const prior = h.calls.at(-1).at;
      await h.run({ runId: 'new-run', collectionId: 'new-collection' });
      assert.ok(h.calls[count].at - prior >= 60000);
    }
  }
});

test('rank/时间变化不改变指纹，正文/真实来源变化改变指纹', async () => {
  const h = setup(); const item = (await h.run()).items[0];
  assert.equal(contentHash({ ...item, rank: 99, observedAt: 'future', stars: 999 }), item.contentHash);
  assert.notEqual(contentHash({ ...item, readme: { ...item.readme, text: 'Changed' } }), item.contentHash);
  assert.notEqual(contentHash({ ...item, readme: { ...item.readme, sourceUrl: item.readme.sourceUrl.replace('release-v2', 'release-v3') } }), item.contentHash);
});

test('不接受外站仓库/README、伪路径和格式参数；有 README 容器但结构异常是失败', async () => {
  for (const value of ['https://evil.invalid/owner/repo', '//evil.invalid/owner/repo', 'javascript:alert(1)', '/a/b/tree/c', '/login/oauth', '/a/..', '/a/%62']) assert.throws(() => repository(value));
  for (const config of [{ since: 'weekly' }, { maxRepos: 101 }, { itemDelayMs: 2999 }, { language: '../x' }, { spokenLanguage: 'x&evil' }, { raw: true }, { maxRepos: undefined }]) assert.throws(() => validateConfig(config));
  const h = setup(); h.data.repos['https://github.com/Alpha/One'].fileHref = 'https://evil.invalid/a/blob/main/README.md';
  const result = await h.run(); assert.equal(result.items.length, 2); assert.equal(result.errors[0].code, 'UNSAFE_URL');
  assert.equal(h.calls.length, 4);
  const malformed = setup(); malformed.data.repos['https://github.com/Alpha/One'].noArticle = true;
  assert.equal((await malformed.run()).errors[0].code, 'SELECTOR_CHANGED');
});

test('README 超过本地上限明确失败，页面截断未知不声称完整原文件', async () => {
  const h = setup(); h.data.repos['https://github.com/Alpha/One'].text = '字'.repeat(180000);
  const result = await h.run();
  assert.equal(result.completeness, 'partial'); assert.equal(result.items.length, 2);
  assert.equal(result.errors[0].code, 'README_TOO_LARGE'); assert.equal(h.calls.length, 4);
});

test('checkpoint schema/hash 检验；输出写失败不丢已持久化 progress', async () => {
  const store = new MemoryCheckpointStore();
  const save = store.save.bind(store); let injected = false;
  store.save = async (runId, collectionId, document) => {
    if (!injected && document.state?.items.length === 2) { injected = true; throw fail('CHECKPOINT_WRITE_FAILED'); }
    return save(runId, collectionId, document);
  };
  const h = setup({ store });
  await assert.rejects(h.run(), /CHECKPOINT_WRITE_FAILED/);
  const prior = await store.load('run-fixture', 'collection-fixture');
  assert.equal(prior.state.items.length, 1); assert.equal(prior.state.attempts['beta/two'], 1);
  const resumed = await h.run({ resume: true }); assert.equal(resumed.items.length, 3);
  assert.equal(h.calls.filter(c => c.url.endsWith('/Alpha/One')).length, 1);
  const doc = await store.load('run-fixture', 'collection-fixture'); doc.state.queue.reverse();
  await save('run-fixture', 'collection-fixture', doc);
  await assert.rejects(h.run({ resume: true }), /CHECKPOINT_INVALID/);
  doc.stateHash = hash(doc.state); await save('run-fixture', 'collection-fixture', doc);
  await assert.rejects(h.run({ resume: true }), /CHECKPOINT_INVALID/);
});

test('真实原子文件写失败保留旧文档；size/path/schema binding 受控', async () => {
  const runId = `plugin-test-${randomUUID()}`; let failWrite = false;
  const root = await mkdtemp(join(tmpdir(), 'plugin-store-'));
  const store = new JsonCheckpointStore({ root, maxBytes: 4096, beforeRename: async () => { if (failWrite) throw new Error('fixture'); } });
  const binding = { runId, collectionId: 'original', pluginVersion: '1', configHash: 'fixture' };
  const cp = checkpoint({ store, binding, validateState: s => Number.isInteger(s.completed) });
  try {
    await cp.commit({ completed: 1 }); failWrite = true;
    await assert.rejects(cp.commit({ completed: 2 }), /CHECKPOINT_WRITE_FAILED/);
    assert.equal(cp.state.completed, 1);
    assert.equal((await store.load(runId, 'original')).state.completed, 1);
    await assert.rejects(store.save(runId, 'original', { text: 'x'.repeat(5000) }), /CHECKPOINT_TOO_LARGE/);
    await assert.rejects(store.save('../escape', 'original', {}), /INVALID_STORAGE_KEY/);
    await assert.rejects(cp.commit({ completed: 'bad' }), /CHECKPOINT_INVALID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

class FixtureCdpPage {
  cdp = new EventEmitter(); sessionId = 'fixture'; calls = [];
  async send(method, params) {
    this.calls.push({ method, params });
    return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'top' } } } : {};
  }
  async navigate(url) {
    this.cdp.emit('event', { sessionId: this.sessionId, method: 'Network.responseReceived', params: { type: 'Document', frameId: 'child', response: { status: 403, url } } });
    this.cdp.emit('event', { sessionId: this.sessionId, method: 'Network.responseReceived', params: { type: 'Document', frameId: 'top', response: { status: 200, url, headers: { 'Retry-After': '10' } } } });
    for (const [requestId, resourceType, target] of [['image', 'Image', url], ['external', 'Document', 'https://evil.invalid/'], ['script', 'Script', 'https://github.com/script.js']]) {
      this.cdp.emit('event', { sessionId: this.sessionId, method: 'Fetch.requestPaused', params: { requestId, resourceType, request: { url: target } } });
    }
  }
  async evaluateRead() { return 'fixture'; }
}
test('CDP 适配器只使用注入页面，阻止图片/外站，读取主文档状态与 RetryAfter', async () => {
  const page = new FixtureCdpPage();
  await withCdpPage(page, async adapter => {
    assert.deepEqual(await adapter.navigate('https://github.com/trending'), { status: 200, url: 'https://github.com/trending', retryAfter: '10' });
    assert.equal(await adapter.evaluateRead('fixture'), 'fixture');
    await assert.rejects(adapter.navigate('https://evil.invalid/'), /UNSAFE_URL/);
  }, { deadline: Date.now() + 5000 });
  assert.deepEqual(page.calls.filter(c => c.method === 'Fetch.failRequest').map(c => c.params.requestId), ['image', 'external']);
  assert.deepEqual(page.calls.filter(c => c.method === 'Fetch.continueRequest').map(c => c.params.requestId), ['script']);
  assert.equal(page.cdp.listenerCount('event'), 0);
});
test('CDP 活动导航可取消且不执行读取，停止加载并回收监听', async () => {
  const page = new FixtureCdpPage(); const controller = new AbortController();
  page.navigate = async () => { controller.abort(); return new Promise(() => {}); };
  await assert.rejects(withCdpPage(page, adapter => adapter.navigate('https://github.com/trending'), { signal: controller.signal, deadline: Date.now() + 5000 }), /CANCELLED/);
  assert.ok(page.calls.some(c => c.method === 'Page.stopLoading'));
  assert.equal(page.cdp.listenerCount('event'), 0);
});

test('snapshot 独立保留全部冻结条目、可见元数据及 key 关联，含 pending/failed', async () => {
  const h = setup({ behavior: url => url.endsWith('/Beta/Two') ? fail('READ_TIMEOUT') : undefined });
  const first = await h.run();
  assert.deepEqual(first.snapshot.entries.map(e => e.status), ['completed', 'pending', 'pending']);
  assert.deepEqual(Object.fromEntries(['description', 'language', 'stars', 'dailyChange'].map(k => [k, first.snapshot.entries[0][k]])),
    { description: 'Alpha tools', language: 'JavaScript', stars: '1,234', dailyChange: '56 stars today' });
  assert.equal(first.items[0].queueKey, first.snapshot.entries[0].key);
  h.data.list.rows = ['/Changed/List'];
  const resumed = await h.run({ resume: true });
  assert.deepEqual(resumed.snapshot.entries.map(e => e.status), ['completed', 'failed', 'completed']);
  assert.equal(resumed.snapshot.entries[1].error, 'READ_TIMEOUT');
  const count = h.calls.length; await h.run({ resume: true }); assert.equal(h.calls.length, count);
});

test('仓库头存在但 README root 失效不能当作 not_found，结构异常阻断整批', async () => {
  const h = setup(); h.data.repos['https://github.com/Beta/Two'].emptyRepository = false;
  const result = await h.run();
  assert.equal(result.errors[0].code, 'SELECTOR_CHANGED'); assert.equal(result.blockedBatch, 'SELECTOR_CHANGED');
  assert.deepEqual(result.items.map(i => i.queueKey), ['alpha/one']);
  const count = h.calls.length; await h.run({ resume: true }); assert.equal(h.calls.length, count);
});

test('正文 src/example.js blob 不得充当 README 来源，header 来源可用且排除正文优先链接', async () => {
  const h = setup(); const repo = h.data.repos['https://github.com/Alpha/One'];
  repo.bodyHref = '/Alpha/Renamed/blob/main/src/example.js';
  assert.equal((await h.run()).items[0].readme.sourceUrl, `https://github.com${repo.fileHref}`);
  const bad = setup(); Object.assign(bad.data.repos['https://github.com/Alpha/One'], { fileHref: null, bodyHref: repo.bodyHref });
  const result = await bad.run(); assert.equal(result.items.length, 0); assert.equal(result.errors[0].code, 'SELECTOR_CHANGED');
});

test('仓库 404 明确失败，普通 HTTP_FAILED 也跳过失败项继续 C', async () => {
  for (const status of [404, 400]) {
    const h = setup({ behavior: url => url.endsWith('/Beta/Two') ? { status } : undefined });
    const result = await h.run();
    assert.deepEqual(result.items.map(i => i.queueKey), ['alpha/one', 'gamma/three']);
    assert.equal(result.errors[0].code, status === 404 ? 'REPOSITORY_NOT_FOUND' : 'HTTP_FAILED');
    assert.deepEqual(result.terminalItemFailures, ['beta/two']);
    assert.equal(result.snapshot.entries[1].status, 'failed');
    const count = h.calls.length; await h.run({ resume: true }); assert.equal(h.calls.length, count);
  }
});

test('resume 放宽 deadline 后导航跨原期限不执行 evaluate；UTC 跨日同样拒绝', async () => {
  for (const boundary of ['deadline', 'date']) {
    let first = true; let resumed = false;
    const h = setup({ behavior: url => {
      if (!url.endsWith('/Beta/Two')) return;
      if (first) { first = false; return fail('READ_TIMEOUT'); }
      if (resumed) h.setTime(Date.parse(boundary === 'deadline' ? '2026-06-01T23:00:01Z' : '2026-06-02T00:00:01Z'));
    } });
    await h.run({ deadline: boundary === 'date' ? '2026-06-03T00:00:00Z' : h.options.deadline }); resumed = true;
    // 若错误地 evaluate，DOM fixture 会立刻抛未知对象错误。
    h.data.repos['https://github.com/Beta/Two'] = { url: 'invalid', missing: true };
    await assert.rejects(h.run({ resume: true, deadline: '2026-06-03T00:00:00Z' }), /DEADLINE_EXCEEDED/);
    assert.equal(h.calls.at(-1).url, 'https://github.com/Beta/Two');
  }
});

test('CDP getFrameTree pending 时取消，清理后 release 不再发初始化命令，宿主只关闭一次', async () => {
  const page = new FixtureCdpPage(); const controller = new AbortController(); let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const send = page.send.bind(page);
  page.send = async (method, params) => {
    if (method === 'Page.getFrameTree') {
      page.calls.push({ method }); entered();
      return new Promise(resolve => { release = () => resolve({ frameTree: { frame: { id: 'top' } } }); });
    }
    return send(method, params);
  };
  let closes = 0;
  const run = (async () => {
    try { await withCdpPage(page, () => assert.fail('must not enter callback'), { signal: controller.signal, deadline: Date.now() + 5000 }); }
    finally { closes++; }
  })();
  await started; controller.abort(); await assert.rejects(run, /CANCELLED/);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1); assert.equal(page.calls.filter(c => c.method === 'Fetch.disable').length, 1);
  assert.equal(page.calls.some(c => c.method.startsWith('Network.') || c.method === 'Fetch.enable'), false);
  assert.equal(page.cdp.listenerCount('event'), 0);
});

test('宿主显式临时 root，默认容器挂载路径，拒绝用户路径及 symlink 边界', async () => {
  assert.equal(new JsonCheckpointStore().root, resolve('/data/spool'));
  assert.throws(() => validateConfig({ root: '../elsewhere' }), /INVALID_CONFIG/);
  const root = await mkdtemp(join(tmpdir(), 'plugin-boundary-'));
  try {
    const store = new JsonCheckpointStore({ root });
    await store.save('run', 'collection', { value: 1 });
    assert.deepEqual(await store.load('run', 'collection'), { value: 1 });
    await assert.rejects(store.save('run', '../escape', {}), /INVALID_STORAGE_KEY/);
    await mkdir(join(root, 'target'));
    await symlink(join(root, 'target'), join(root, 'linked'), 'junction');
    await assert.rejects(store.save('linked', 'collection', {}), /UNSAFE_STORAGE_PATH/);
    const linkedRoot = new JsonCheckpointStore({ root: join(root, 'linked') });
    await assert.rejects(linkedRoot.save('run', 'collection', {}), /UNSAFE_STORAGE_PATH/);
    // Windows 无需提升权限的 junction，同样验证 collection 文件位置的链接拒绝。
    await symlink(join(root, 'target'), join(root, 'run', 'alias.json'), 'junction');
    await assert.rejects(store.load('run', 'alias'), /CHECKPOINT_READ_FAILED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('manifest 实际 schema 验证 complete/partial，拒绝缺 snapshot/关联键/元数据和非法状态', async () => {
  const h = setup(); const draft = await h.run();
  checkSchema(plugin.manifest.outputSchema, draft);
  const { checkpoint: metadata, ...payload } = draft;
  checkSchema(plugin.manifest.outputSchema, payload);
  const partial = await setup({ behavior: url => url.endsWith('/Beta/Two') ? fail('READ_TIMEOUT') : undefined }).run();
  checkSchema(plugin.manifest.outputSchema, partial);
  const mutations = [
    d => { delete d.snapshot; }, d => { delete d.snapshot.entries; },
    d => { delete d.terminalItemFailures; }, d => { delete d.blockedBatch; },
    d => { delete d.items[0].queueKey; }, d => { d.snapshot.entries[0].status = 'illegal'; },
    d => { d.items[0].readme.status = 'illegal'; },
    ...['key', 'url', 'rank', 'description', 'language', 'stars', 'dailyChange', 'status', 'error'].map(key => d => { delete d.snapshot.entries[0][key]; })
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(draft); mutate(invalid);
    assert.throws(() => checkSchema(plugin.manifest.outputSchema, invalid));
  }
});

test('首次 seal 从持久 state 重建权威 payload，保留 hash 也不能删改输出', async () => {
  const h = setup(); const draft = await h.run(); const calls = h.calls.length;
  for (const mutate of [
    d => { delete d.snapshot; }, d => { d.snapshot.entries = []; },
    d => { d.snapshot.entries[0].description = 'forged'; }, d => { delete d.items; },
    d => { d.items = []; }, d => { d.items[0].readme.text = 'forged'; },
    d => { delete d.completeness; }, d => { d.completeness = 'partial'; }
  ]) {
    const altered = structuredClone(draft); mutate(altered);
    await assert.rejects(sealPluginResult(plugin, h.options, altered), /DRAFT_PAYLOAD_MISMATCH/);
    assert.equal((await h.store.load(h.options.runId, h.options.collectionId)).phase, 'OPEN');
  }
  const submission = await sealPluginResult(plugin, h.options, draft);
  assert.deepEqual(submission.payload.items, draft.items);
  assert.deepEqual(await sealPluginResult(plugin, h.options, draft), submission);
  assert.equal(h.calls.length, calls);
});

function largeSetup(count, store) {
  const data = structuredClone(fixture);
  data.list.rows = []; data.repos = {};
  for (let i = 0; i < count; i++) {
    const url = `https://github.com/Owner/Repo${i}`;
    data.list.rows.push(`/Owner/Repo${i}`);
    data.repos[url] = { url, text: 'x'.repeat(500 * 1024), fileHref: `/Owner/Repo${i}/blob/main/README.md` };
  }
  return setup({ data, store, config: { maxRepos: count } });
}

test('9 份 500KiB 正文真实文件 OPEN/SEALED 均低于默认 8MiB，SEALED 无重复 state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-large-'));
  try {
    const store = new JsonCheckpointStore({ root }); const h = largeSetup(9, store);
    assert.equal(store.maxBytes, DEFAULT_CHECKPOINT_MAX_BYTES);
    const draft = await h.run(); assert.equal(draft.completeness, 'complete'); assert.equal(draft.items.length, 9);
    const before = await store.load(h.options.runId, h.options.collectionId);
    const submission = await sealPluginResult(plugin, h.options, draft);
    const after = await store.load(h.options.runId, h.options.collectionId);
    assert.equal(after.schemaVersion, 3); assert.equal(Object.hasOwn(after, 'state'), false);
    assert.equal(after.stateHash, draft.checkpoint.stateHash);
    assert.ok(Buffer.byteLength(canonical(before)) < DEFAULT_CHECKPOINT_MAX_BYTES);
    assert.ok(Buffer.byteLength(canonical(after)) < DEFAULT_CHECKPOINT_MAX_BYTES);
    const cp = checkpoint({ store, binding: after.binding, validateState: () => assert.fail('SEALED 不验证 OPEN state') });
    assert.equal(await cp.load(), null); assert.equal(cp.state, null); assert.equal(cp.phase, 'SEALED');
    assert.deepEqual(await readSealedSubmission(plugin, h.options), submission);
    assert.deepEqual(await sealPluginResult(plugin, h.options, draft), submission);
    await assert.rejects(readOpenDraft(plugin, h.options), /COLLECTION_SEALED/);
    await assert.rejects(cp.commit({}), /COLLECTION_SEALED/);
    const invalid = structuredClone(after); invalid.state = {};
    await store.save(h.options.runId, h.options.collectionId, invalid);
    await assert.rejects(readSealedSubmission(plugin, h.options), /CHECKPOINT_INVALID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('临界预算按最终封存包接纳 OPEN，少一字节返回可封存 partial', async () => {
  const baseline = largeSetup(2); const draft = await baseline.run();
  const openDoc = await baseline.store.load(baseline.options.runId, baseline.options.collectionId);
  await sealPluginResult(plugin, baseline.options, draft);
  const sealedDoc = await baseline.store.load(baseline.options.runId, baseline.options.collectionId);
  const budget = Buffer.byteLength(canonical(sealedDoc));
  assert.ok(budget > Buffer.byteLength(canonical(openDoc)));
  const root = await mkdtemp(join(tmpdir(), 'plugin-budget-'));
  try {
    for (const delta of [0, -1]) {
      const store = new JsonCheckpointStore({ root: join(root, `case${delta}`), maxBytes: budget + delta });
      const h = largeSetup(2, store); const result = await h.run();
      assert.equal(result.items.length, delta === 0 ? 2 : 1);
      assert.equal(result.completeness, delta === 0 ? 'complete' : 'partial');
      assert.deepEqual(await readOpenDraft(plugin, h.options), result);
      const submission = await sealPluginResult(plugin, h.options, result);
      assert.deepEqual(await readSealedSubmission(plugin, h.options), submission);
      assert.ok(Buffer.byteLength(canonical(await store.load(h.options.runId, h.options.collectionId))) <= budget + delta);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('maxBytes 显式冲突提前拒绝，file store 预算继承，非法预算拒绝', async () => {
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new JsonCheckpointStore({ maxBytes }), /INVALID_CHECKPOINT_MAX_BYTES/);
  const root = await mkdtemp(join(tmpdir(), 'plugin-limit-'));
  try {
    const store = new JsonCheckpointStore({ root, maxBytes: 4096 }); const h = setup({ store });
    await assert.rejects(h.run({ maxBytes: 8192 }), /CHECKPOINT_MAX_BYTES_MISMATCH/);
    assert.equal(h.calls.length, 0);
    await assert.rejects(readOpenDraft(plugin, { ...h.options, maxBytes: 8192 }), /CHECKPOINT_MAX_BYTES_MISMATCH/);
    await assert.rejects(readSealedSubmission(plugin, { ...h.options, maxBytes: 8192 }), /CHECKPOINT_MAX_BYTES_MISMATCH/);
    await assert.rejects(sealPluginResult(plugin, { ...h.options, maxBytes: 8192 }, {}), /CHECKPOINT_MAX_BYTES_MISMATCH/);
    assert.throws(() => checkpoint({ store, binding: {}, validateState: () => true, maxBytes: 8192 }), /CHECKPOINT_MAX_BYTES_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
