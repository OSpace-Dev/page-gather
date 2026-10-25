import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { fixtureDocument } from './helpers/fixture-dom.js';
import { checkSchema } from './helpers/schema.js';
import { expression, readRepoDom } from '../../../plugins/github-trending/dom.js';
import plugin, { contentHash } from '../../../plugins/github-trending/index.js';
import { MemoryCheckpointStore, runPlugin, createLimiter, sealPluginResult, hash } from '../../../packages/plugin-sdk/index.js';
const fixture = JSON.parse(await readFile(new URL('./fixtures/plugin-github-modern-dom.json', import.meta.url)));
const dom = (tree, url = fixture.url) => runInNewContext(expression(readRepoDom), { document: fixtureDocument(tree), location: { href: url }, URL });
function setup(tree = structuredClone(fixture.tree)) {
  let time = Date.parse('2026-06-01T12:00:00Z'); let current; const calls = [];
  const list = ['main', {}, ['article', { class: 'Box-row' }, ['h2', {}, ['a', { href: fixture.url }, 'Modern/Project']]]];
  const store = new MemoryCheckpointStore();
  const options = { runId: 'modern-fixture', collectionId: 'modern-collection', collectionSeq: 1, taskSnapshotRef: 'fixture',
    config: { maxRepos: 1 }, deadline: '2026-06-01T23:00:00Z', store, limiter: createLimiter(),
    clock: { now: () => time, sleep: async ms => { time += ms; } },
    withPage: async fn => fn({
      async navigate(url) { calls.push(url); current = url.includes('/trending?') ? { tree: list, url } : { tree, url: fixture.url }; return { status: 200 }; },
      async evaluateRead(expr) { return runInNewContext(expr, { document: fixtureDocument(current.tree), location: { href: current.url }, URL }); }
    }) };
  return { options, calls, store, run: () => runPlugin(plugin, options) };
}

test('现代 server DOM 通过当前 README 导航与唯一相邻 article 关联，完整 collect/seal 使用页面来源', async () => {
  const h = setup(); const draft = await h.run(); const readme = draft.items[0].readme;
  assert.equal(draft.completeness, 'complete'); assert.equal(readme.status, 'found');
  assert.equal(readme.text, 'Modern rendered README fixture. Documentation');
  assert.equal(readme.sourceKind, 'rendered_page'); assert.equal(readme.fileSourceUrl, null);
  assert.equal(readme.sourceUrl, `${fixture.url}#readme-ov-file`);
  assert.equal(plugin.validateState((await h.store.load(h.options.runId, h.options.collectionId)).state), true);
  checkSchema(plugin.manifest.outputSchema, draft);
  const submission = await sealPluginResult(plugin, h.options, draft);
  assert.equal(submission.payloadHash, hash(submission.payload)); assert.equal(h.calls.length, 2);
});

test('现代明确 header 文件链接优先；目录和正文 blob README 均不能替代来源', async () => {
  const tree = structuredClone(fixture.tree);
  tree[4][2].push(['div', { 'data-testid': 'readme-header' }, ['a', { href: '/Modern/Project/blob/release/docs/README.rst' }, 'README.rst']]);
  const h = setup(tree); const draft = await h.run(); const r = draft.items[0].readme;
  assert.equal(r.sourceKind, 'file'); assert.equal(r.sourceUrl, 'https://github.com/Modern/Project/blob/release/docs/README.rst');
  assert.equal(r.fileSourceUrl, r.sourceUrl); checkSchema(plugin.manifest.outputSchema, draft);
});

const invalidCases = [
  ['license 当前项', t => { t[4][2][3][2][2][2][1]['aria-current'] = 'false'; t[4][2][3][2][3][2][1]['aria-current'] = 'page'; }],
  ['缺少当前项语义', t => { delete t[4][2][3][2][2][2][1]['aria-current']; }],
  ['多个当前项', t => { t[4][2][3][2][3][2][1]['aria-current'] = 'page'; }],
  ['导航标签失效', t => { t[4][2][3][1]['aria-label'] = 'Other navigation'; }],
  ['header 不再与正文相邻', t => { t.push(t[4].splice(2, 1)[0]); }],
  ['多个 markdown article', t => { t[4][3].push(['article', { class: 'markdown-body' }, 'License body']); }],
  ['导航隐藏', t => { t[4][2][1]['aria-hidden'] = 'true'; }],
  ['article 隐藏', t => { t[4][3][1].hidden = ''; }],
  ['缺少页面真实 README anchor', t => { t.pop(); }],
  ['仅正文中有伪 README anchor', t => { t.pop(); t[4][3][2].push(['a', { href: '#readme-ov-file' }, 'README']); }]
];
for (const [label, mutate] of invalidCases) {
  test(`现代结构拒绝 ${label}，保持 SELECTOR_CHANGED 而非 not_found`, async () => {
    const tree = structuredClone(fixture.tree); mutate(tree);
    assert.equal(dom(tree).readmePresent, false);
    const result = await setup(tree).run();
    assert.equal(result.items.length, 0); assert.equal(result.blockedBatch, 'SELECTOR_CHANGED');
    assert.equal(result.completeness, 'partial'); assert.equal(result.errors[0].code, 'SELECTOR_CHANGED');
  });
}
for (const suffix of ['/wiki', '/issues/1', '/blob/main/README.md']) {
  test(`现代结构拒绝仓库概览以外路径 ${suffix}`, () => {
    const d = dom(structuredClone(fixture.tree), `${fixture.url}${suffix}`);
    assert.equal(d.readmePresent, false); assert.equal(d.absenceEvidence, null);
  });
}

test('来源 kind/文件链接参与 contentHash，schema/state 拒绝缺失、非法或矛盾来源', async () => {
  const h = setup(); const draft = await h.run(); const item = draft.items[0];
  for (const mutate of [
    r => { delete r.sourceKind; }, r => { delete r.fileSourceUrl; }, r => { r.sourceKind = 'guessed'; }
  ]) {
    const altered = structuredClone(draft); mutate(altered.items[0].readme);
    assert.throws(() => checkSchema(plugin.manifest.outputSchema, altered));
  }
  const saved = await h.store.load(h.options.runId, h.options.collectionId);
  for (const mutate of [
    r => { r.sourceKind = 'file'; }, r => { r.fileSourceUrl = 'https://github.com/Modern/Project/blob/main/README.md'; },
    r => { r.sourceUrl = `${fixture.url}#license-ov-file`; }, r => { r.sourceUrl = 'https://evil.invalid/Modern/Project#readme-ov-file'; },
    r => { r.sourceUrl = `${fixture.url}/wiki#readme-ov-file`; }
  ]) {
    const state = structuredClone(saved.state); mutate(state.items[0].readme);
    state.items[0].contentHash = contentHash(state.items[0]);
    assert.equal(plugin.validateState(state), false);
    assert.notEqual(state.items[0].contentHash, item.contentHash);
  }
});
