import { readFileSync } from 'node:fs';
import { fail, hash } from '../../packages/plugin-sdk/index.js';
import { expression, readListDom, readRepoDom } from './dom.js';

export const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(manifest.configSchema.properties, k))) throw fail('INVALID_CONFIG');
  const config = { since: 'daily', maxRepos: 25, itemDelayMs: 5000, ...input };
  if (config.since !== 'daily' || !Number.isInteger(config.maxRepos) || config.maxRepos < 1 || config.maxRepos > 100 ||
      !Number.isInteger(config.itemDelayMs) || config.itemDelayMs < 3000 || config.itemDelayMs > 3600000) throw fail('INVALID_CONFIG');
  for (const field of ['language', 'spokenLanguage']) {
    if (config[field] !== undefined && (typeof config[field] !== 'string' || !new RegExp(manifest.configSchema.properties[field].pattern).test(config[field]))) throw fail('INVALID_CONFIG');
  }
  return config;
}
function githubUrl(value, base = 'https://github.com') {
  let url;
  try { url = new URL(value, base); } catch { throw fail('UNSAFE_URL'); }
  if (url.origin !== 'https://github.com' || url.username || url.password || url.port) throw fail('UNSAFE_URL');
  return url;
}
export function repository(value) {
  const url = githubUrl(value);
  const parts = url.pathname.match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/?$/);
  if (!parts || ['.', '..'].includes(parts[2]) || ['trending', 'login', 'settings', 'features', 'orgs', 'users', 'marketplace', 'topics', 'collections', 'sponsors'].includes(parts[1].toLowerCase())) throw fail('INVALID_REPOSITORY');
  return { key: `${parts[1]}/${parts[2]}`.toLowerCase(), url: `https://github.com/${parts[1]}/${parts[2]}` };
}
function fileUrl(value, repo) {
  const url = githubUrl(value);
  const prefix = `${new URL(repo.url).pathname}/blob/`.toLowerCase();
  if (!url.pathname.toLowerCase().startsWith(prefix) || url.pathname.length <= prefix.length) throw fail('INVALID_README_SOURCE');
  url.hash = ''; url.search = ''; return url.href;
}
function renderedPageUrl(value, repo) {
  const url = githubUrl(value);
  if (repository(url.href).key !== repo.key || !['#readme', '#readme-ov-file'].includes(url.hash)) throw fail('INVALID_README_SOURCE');
  return url.href;
}
export function contentHash(item) {
  // 整个 readme（含 sourceKind/fileSourceUrl）参与指纹，页面来源与明确文件来源不能混同。
  return hash({ sourceKey: item.sourceKey, sourceUrl: item.sourceUrl, readme: item.readme });
}
const codes = new Set(['NETWORK_TRANSIENT', 'NAVIGATION_FAILED', 'NAVIGATION_TIMEOUT', 'READ_TIMEOUT', 'READ_FAILED', 'CDP_COMMAND_TIMEOUT', 'CDP_DISCONNECTED', 'RATE_LIMITED', 'ACCESS_DENIED', 'CHALLENGE_REQUIRED', 'REPOSITORY_NOT_FOUND', 'HTTP_FAILED', 'SELECTOR_CHANGED', 'UNSAFE_URL', 'INVALID_REPOSITORY', 'INVALID_README_SOURCE', 'README_TOO_LARGE']);
const transient = new Set(['NETWORK_TRANSIENT', 'NAVIGATION_FAILED', 'NAVIGATION_TIMEOUT', 'READ_TIMEOUT', 'READ_FAILED', 'CDP_COMMAND_TIMEOUT', 'CDP_DISCONNECTED']);
const blocked = new Set(['RATE_LIMITED', 'ACCESS_DENIED', 'CHALLENGE_REQUIRED', 'SELECTOR_CHANGED']);
const date = time => new Date(time).toISOString().slice(0, 10);
export function validateState(s) {
  if (!s || !Number.isFinite(Date.parse(s.observedAt)) || s.capturedDate !== date(Date.parse(s.observedAt)) || !Number.isFinite(s.expiresAt) ||
      !Array.isArray(s.queue) || s.queue.length > 100 || !Array.isArray(s.terminalItemFailures) || !(s.blockedBatch === null || codes.has(s.blockedBatch)) || !Array.isArray(s.items) || !s.attempts || typeof s.attempts !== 'object' || !Array.isArray(s.errors)) return false;
  try {
    const keys = s.queue.map((q, i) => { if (q.rank !== i + 1 || repository(q.url).key !== q.key || ['description', 'language', 'stars', 'dailyChange'].some(k => q[k] !== null && typeof q[k] !== 'string')) throw fail('CHECKPOINT_INVALID'); return q.key; });
    if (new Set(keys).size !== keys.length || s.items.length > keys.length || new Set(s.items.map(i => i.queueKey)).size !== s.items.length) return false;
    for (const i of s.items) {
      if (!keys.includes(i.queueKey) || i.contentHash !== contentHash(i) || repository(i.sourceUrl).key !== i.sourceKey || !Number.isFinite(Date.parse(i.observedAt)) || i.readme.format !== 'rendered_text' || i.readme.truncated !== null) return false;
      if (i.readme.status === 'found') {
        if (typeof i.readme.text !== 'string') return false;
        const repo = repository(i.sourceUrl);
        if (i.readme.sourceKind === 'file') {
          if (fileUrl(i.readme.fileSourceUrl, repo) !== i.readme.fileSourceUrl || i.readme.sourceUrl !== i.readme.fileSourceUrl) return false;
        } else if (i.readme.sourceKind !== 'rendered_page' || i.readme.fileSourceUrl !== null || renderedPageUrl(i.readme.sourceUrl, repo) !== i.readme.sourceUrl) return false;
      } else if (i.readme.status !== 'not_found' || i.readme.text !== null || i.readme.sourceUrl !== null || i.readme.sourceKind !== null || i.readme.fileSourceUrl !== null) return false;
    }
    if (Object.entries(s.attempts).some(([k, n]) => !keys.includes(k) || !Number.isInteger(n) || n < 0 || n > 2)) return false;
    if (new Set(s.terminalItemFailures).size !== s.terminalItemFailures.length || s.terminalItemFailures.some(k => !keys.includes(k) || s.items.some(i => i.queueKey === k) || s.attempts[k] !== 2 || !s.errors.some(e => e.itemKey === k))) return false;
    return s.errors.every(e => (keys.includes(e.itemKey) || e.itemKey === 'trending') && codes.has(e.code));
  } catch { return false; }
}
function result(ctx, s) {
  return { collectionId: ctx.collectionId, collectionSeq: ctx.collectionSeq,
    scopeKey: `github-trending:daily:${ctx.config.language ?? 'all'}:${ctx.config.spokenLanguage ?? 'all'}`,
    completeness: s.items.length === s.queue.length && !s.errors.length ? 'complete' : 'partial',
    observedAt: s.observedAt, capturedDate: s.capturedDate,
    snapshot: { observedAt: s.observedAt, capturedDate: s.capturedDate, entries: s.queue.map(q => ({ ...q,
      status: s.items.some(i => i.queueKey === q.key) ? 'completed' : s.terminalItemFailures.includes(q.key) ? 'failed' : 'pending',
      error: s.errors.find(e => e.itemKey === q.key)?.code ?? null })) },
    terminalItemFailures: s.terminalItemFailures, blockedBatch: s.blockedBatch, items: s.items, errors: s.errors };
}
function assertFresh(ctx, state) {
  ctx.check();
  if (ctx.now() >= state.expiresAt || date(ctx.now()) !== state.capturedDate) throw fail('COLLECTION_EXPIRED');
}
async function read(ctx, page, url, extractor, state) {
  if (state) assertFresh(ctx, state);
  await ctx.throttle(ctx.config.itemDelayMs);
  if (state) assertFresh(ctx, state);
  const response = await page.navigate(url);
  if (state) assertFresh(ctx, state); else ctx.check();
  if (!response || !Number.isInteger(response.status)) throw fail('HTTP_FAILED');
  if (response.retryAfter) {
    const seconds = Number(response.retryAfter);
    const until = Number.isFinite(seconds) ? ctx.now() + Math.max(0, seconds * 1000) : Date.parse(response.retryAfter);
    if (Number.isFinite(until)) ctx.defer(until);
  }
  if (response.status === 429) throw fail('RATE_LIMITED');
  if (response.status === 403) throw fail('ACCESS_DENIED');
  if (response.status >= 500) throw fail('NETWORK_TRANSIENT');
  if (response.status === 404 && state) throw fail('REPOSITORY_NOT_FOUND');
  if (response.status !== 200) throw fail('HTTP_FAILED');
  if (state) assertFresh(ctx, state); else ctx.check();
  const dom = await page.evaluateRead(expression(extractor));
  ctx.check(); githubUrl(dom.url);
  if (dom.challenge) throw fail('CHALLENGE_REQUIRED');
  if (state) assertFresh(ctx, state);
  return dom;
}

export async function collect(ctx) {
  let state = ctx.checkpoint.state;
  if (state) assertFresh(ctx, state);
  ctx.constrainDeadline(state?.expiresAt ?? Date.parse(`${date(ctx.now())}T00:00:00Z`) + 86400000);
  // 整批阻断不再碰页面，单项终止失败则跳过并继续队列。
  if (state?.blockedBatch) return result(ctx, state);
  return ctx.withPage(async page => {
    if (!state) {
      const url = new URL(`https://github.com/trending${ctx.config.language ? `/${encodeURIComponent(ctx.config.language)}` : ''}`);
      url.searchParams.set('since', 'daily');
      if (ctx.config.spokenLanguage) url.searchParams.set('spoken_language_code', ctx.config.spokenLanguage);
      const dom = await read(ctx, page, url.href, readListDom);
      if (new URL(dom.url).pathname !== url.pathname || !dom.listPresent || !Array.isArray(dom.rows) || !dom.rows.length) throw fail('SELECTOR_CHANGED');
      const seen = new Set(); const queue = [];
      for (const row of dom.rows) {
        const repo = repository(row.href);
        if (!seen.has(repo.key)) { seen.add(repo.key); queue.push({ ...repo, rank: queue.length + 1, ...Object.fromEntries(['description', 'language', 'stars', 'dailyChange'].map(k => [k, typeof row[k] === 'string' ? row[k] : null])) }); }
        if (queue.length === ctx.config.maxRepos) break;
      }
      const observedAt = new Date(ctx.now()).toISOString();
      state = { queue, observedAt, capturedDate: date(ctx.now()), expiresAt: Math.min(ctx.deadline, Date.parse(`${date(ctx.now())}T00:00:00Z`) + 86400000), items: [], attempts: {}, errors: [], terminalItemFailures: [], blockedBatch: null };
      await ctx.commit(state); // 首次冻结有序队列，后续恢复绝不重读榜单。
    }
    for (const queued of state.queue) {
      assertFresh(ctx, state);
      if (state.items.some(i => i.queueKey === queued.key)) continue;
      if (state.terminalItemFailures.includes(queued.key)) continue;
      if ((state.attempts[queued.key] ?? 0) >= 2) {
        state = { ...state, terminalItemFailures: [...state.terminalItemFailures, queued.key],
          errors: [...state.errors.filter(e => e.itemKey !== queued.key), { itemKey: queued.key, code: state.errors.find(e => e.itemKey === queued.key)?.code ?? 'READ_FAILED' }] };
        await ctx.commit(state); continue;
      }
      // 发出只读请求前持久化预算，崩溃也不会重置重试次数。
      state = { ...state, attempts: { ...state.attempts, [queued.key]: (state.attempts[queued.key] ?? 0) + 1 } };
      await ctx.commit(state);
      let item;
      try {
        const dom = await read(ctx, page, queued.url, readRepoDom, state);
        const repo = repository(dom.url); // 同站仓库重命名以真实落地 URL 归一化。
        if (!dom.repoPresent) throw fail('SELECTOR_CHANGED');
        let readme;
        if (!dom.readmePresent && dom.absenceEvidence === 'github_empty_repository_quick_setup') readme = { status: 'not_found', format: 'rendered_text', text: null, sourceUrl: null, sourceKind: null, fileSourceUrl: null, truncated: null };
        else if (!dom.readmePresent) throw fail('SELECTOR_CHANGED');
        else {
          if (typeof dom.text !== 'string' || (!dom.fileHref && !dom.pageHref)) throw fail('SELECTOR_CHANGED');
          if (Buffer.byteLength(dom.text) > 512 * 1024) throw fail('README_TOO_LARGE');
          const fileSourceUrl = dom.fileHref ? fileUrl(dom.fileHref, repo) : null;
          readme = { status: 'found', format: 'rendered_text', text: dom.text.replace(/\r\n?/g, '\n').trim(),
            sourceKind: fileSourceUrl ? 'file' : 'rendered_page', fileSourceUrl,
            sourceUrl: fileSourceUrl ?? renderedPageUrl(dom.pageHref, repo), truncated: null };
        }
        item = { queueKey: queued.key, sourceKey: repo.key, sourceUrl: repo.url, rank: queued.rank, observedAt: new Date(ctx.now()).toISOString(), readme };
        item.contentHash = contentHash(item);
      } catch (error) {
        ctx.check();
        if (!codes.has(error.code ?? error.message)) throw error; // cancel/deadline/落盘异常不得吞掉。
        const code = error.code ?? error.message;
        const stopBatch = blocked.has(code);
        const terminal = !stopBatch && (!transient.has(code) || state.attempts[queued.key] >= 2);
        state = { ...state, errors: [...state.errors.filter(e => e.itemKey !== queued.key), { itemKey: queued.key, code }],
          attempts: { ...state.attempts, [queued.key]: terminal ? 2 : state.attempts[queued.key] },
          terminalItemFailures: terminal ? [...state.terminalItemFailures, queued.key] : state.terminalItemFailures,
          blockedBatch: stopBatch ? code : null };
        await ctx.commit(state); ctx.progress(queued.key, code);
        if (stopBatch || !terminal) return result(ctx, state);
        continue;
      }
      // 输出和 completed（items 的 queueKey）一次写入同文档；失败时旧文档仍可恢复。
      const next = { ...state, items: [...state.items, item], errors: state.errors.filter(e => e.itemKey !== queued.key) };
      try { await ctx.commit(next); }
      catch (error) {
        if (error.code !== 'CHECKPOINT_TOO_LARGE') throw error;
        // 未接纳的正文不进入草稿；保留已持久化项及 pending，供宿主封存 partial。
        return result(ctx, state);
      }
      state = next; ctx.progress(queued.key, 'COMPLETED');
    }
    return result(ctx, state);
  });
}
export default { manifest, validateConfig, validateState, collect, snapshotResult: result };
