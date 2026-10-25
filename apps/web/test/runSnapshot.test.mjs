import test from 'node:test'
import assert from 'node:assert/strict'
import { runProjectSnapshot } from '../src/runSnapshot.ts'

const entry = { key: 'old/project', rank: 1, status: 'completed', url: 'https://github.com/old/project' }
const readme = { status: 'found', format: 'rendered_text', text: '<script>untrusted()</script>\nREADME 原文', sourceUrl: 'https://github.com/new/project#readme', truncated: null }
const item = { queueKey: entry.key, sourceKey: 'new/project', sourceUrl: 'https://github.com/new/project', observedAt: '2026-01-01T00:00:00Z', readme }
const archivedRun = { id: 'archived-run', status: 'SUCCEEDED', resultSummary: { disposition: 'stale' }, result: { items: [item] } }

test('STALE 独有项目无需实体即可按 queueKey 读取归档 README，并保留重命名后的来源', () => {
  const result = runProjectSnapshot(archivedRun, entry)
  assert.equal(result.state, 'available')
  assert.equal(result.sourceKey, 'new/project')
  assert.equal(result.sourceUrl, item.sourceUrl)
  assert.equal(result.readme.text, readme.text)
  assert.equal(result.observedAt, item.observedAt)
  assert.equal('currentVersionId' in result, false)
})

test('不会借用其他队列项目、当前实体或旧版本的正文', () => {
  const result = runProjectSnapshot({ ...archivedRun, result: { items: [{ ...item, queueKey: 'other/repo' }] }, readme }, entry)
  assert.equal(result.state, 'missing')
  assert.equal(result.readme, null)
})

for (const status of ['pending', 'failed']) {
  test(`${status} 即使存在同名结果也不显示成功正文`, () => {
    const result = runProjectSnapshot(archivedRun, { ...entry, status })
    assert.equal(result.state, status)
    assert.equal(result.readme, null)
  })
}

test('明确区分 README 缺失与正文结构不匹配', () => {
  const absent = runProjectSnapshot({ ...archivedRun, result: { items: [{ ...item, readme: { ...readme, status: 'not_found', text: null } }] } }, entry)
  assert.equal(absent.state, 'available')
  assert.equal(absent.readme.status, 'not_found')
  const malformed = runProjectSnapshot({ ...archivedRun, result: { items: [{ ...item, readme: { ...readme, text: {} } }] } }, entry)
  assert.equal(malformed.state, 'missing')
  assert.equal(malformed.readme, null)
})
