import type { Entry, Row, Run } from './api.ts'

const record = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)

export interface RunProjectSnapshot {
  state: 'pending' | 'failed' | 'available' | 'missing'
  sourceKey: string
  sourceUrl: unknown
  observedAt: unknown
  readme: Row | null
}

// 运行正文只按冻结队列 queueKey 关联，不借用当前实体的正文或版本。
export function runProjectSnapshot(run: Run | null, entry: Entry): RunProjectSnapshot {
  const base = { sourceKey: entry.key, sourceUrl: entry.url, observedAt: run?.snapshot?.observedAt, readme: null }
  if (entry.status === 'pending' || entry.status === 'failed') return { ...base, state: entry.status }
  const result = run?.result
  const item = record(result) && Array.isArray(result.items)
    ? result.items.find((candidate: unknown) => record(candidate) && candidate.queueKey === entry.key)
    : undefined
  if (!record(item)) return { ...base, state: 'missing' }
  const snapshot = { ...base, sourceKey: typeof item.sourceKey === 'string' ? item.sourceKey : entry.key, sourceUrl: item.sourceUrl, observedAt: item.observedAt }
  const readme = item.readme
  if (!record(readme) || readme.format !== 'rendered_text' || !(
    readme.status === 'found' && typeof readme.text === 'string' ||
    readme.status === 'not_found' && readme.text === null
  )) return { ...snapshot, state: 'missing' }
  return { ...snapshot, state: 'available', readme }
}
