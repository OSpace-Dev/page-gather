import { parseSchedule, scheduleReason } from './schedule.ts'
import type { Schedule } from './schedule.ts'
export type Row = Record<string, unknown>
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface Task extends Row { id: string; name: string; enabled: boolean; config: Row; schedule: Schedule }
export interface Entry extends Row { key: string; rank: number; status: string; entityId?: string; url?: string; description?: string; language?: string; stars?: string; dailyChange?: string; error?: unknown }
export interface Run extends Row { id: string; status: string; snapshot?: { entries: Entry[]; observedAt?: string }; progress?: Row; resultSummary?: Row; error?: unknown }
export interface Entity extends Row { id: string }
export const record = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
export function row(v: unknown): Row { if (!record(v)) throw new ApiError('接口数据格式不匹配，请重试或联系管理员。'); return v }
export function identified(v: unknown): Row & { id: string } { const r = row(v); if (typeof r.id !== 'string') throw new ApiError('接口缺少记录标识。'); return r as Row & { id: string } }
export function task(v: unknown): Task { const r = identified(v); if (typeof r.name !== 'string' || typeof r.enabled !== 'boolean' || !record(r.config)) throw new ApiError('任务配置格式不匹配。'); return { ...r, schedule: parseSchedule(r.schedule) } as Task }
export function run(v: unknown): Run {
  const r = identified(v)
  if (typeof r.status !== 'string' || !['QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED','RECOVERING','SKIPPED'].includes(r.status)) throw new ApiError('运行状态格式不匹配。')
  // 尚未提交结果时，服务端 snapshot 是任务参数快照；提交后才是榜单快照。
  if (r.snapshot != null) {
    const s = row(r.snapshot)
    if ('entries' in s) {
      if (!Array.isArray(s.entries) || !s.entries.every(e => record(e) && typeof e.key === 'string' && typeof e.rank === 'number' && ['pending','completed','failed'].includes(String(e.status)))) throw new ApiError('榜单快照格式不匹配。')
    } else if (typeof s.taskId === 'string' && record(s.config)) { r.taskSnapshot = s; r.snapshot = undefined }
    else throw new ApiError('榜单快照格式不匹配。')
  }
  if (r.progress != null && !record(r.progress)) throw new ApiError('运行进度格式不匹配。')
  return r as Run
}
export function page<T>(v: unknown, parse: (x: unknown) => T): Page<T> {
  const r = row(v)
  if (!Array.isArray(r.items) || (r.nextCursor != null && typeof r.nextCursor !== 'string')) throw new ApiError('列表格式不匹配。')
  return { items: r.items.map(parse), nextCursor: r.nextCursor as string | null ?? null }
}
export class ApiError extends Error { status: number; constructor(message: string, status = 0) { super(message); this.status = status } }
const messages: Record<string, string> = { NOTIFICATION_NOT_FOUND:'通知不存在或已不可访问，请返回列表刷新。', RULE_NOT_FOUND:'规则不存在，请刷新列表。', INVALID_RULE:'规则参数不符合服务端要求，请检查名称、任务、事件与关键词。', PUSH_DISABLED:'服务器推送已关闭；站内通知仍可用。', PUSH_NOT_CONFIGURED:'服务器未配置推送；站内通知仍可用。', PUSH_NO_DEVICES:'当前设备未启用订阅，请先主动订阅本机。', SUBSCRIPTION_NOT_FOUND:'本机设备订阅不存在，请重新登记本机后重试。', SUBSCRIPTION_NOT_OWNED:'此订阅不属于当前会话，请先重新登记本机。', SUBSCRIPTION_EXPIRED:'本机订阅已过期，请重新订阅。', INVALID_SUBSCRIPTION:'浏览器订阅格式不符合要求，请重新登记。', INVALID_SUBSCRIPTION_KEYS:'浏览器订阅密钥格式无效，请重新订阅。', INVALID_PUSH_ENDPOINT:'此推送服务端点不受支持，请检查浏览器支持情况。', IDEMPOTENCY_CONFLICT:'同一请求标识的内容不一致，请刷新后重新操作。', INVALID_CREDENTIALS: '用户名或密码错误，请重新登录。', INVALID_CONFIG: '任务参数不符合要求，请检查后重试。', INVALID_SCHEDULE: '每日计划时间或时区不符合服务端要求，请检查后重试。', RATE_LIMITED: '操作过于频繁，请稍后重试。', TASK_DISABLED: '请先启用任务。', INVALID_ORIGIN: '访问地址未获授权，请联系管理员。' }
export async function api(path: string, method = 'GET', body?: unknown, key?: string): Promise<unknown> {
  let res: Response
  try { res = await fetch(`/api/v1${path}`, { method, cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) }) }
  catch { throw new ApiError('连接失败或请求超时，请检查网络后重试。') }
  let value: unknown
  try { value = await res.json() } catch { throw new ApiError('服务返回了无法识别的响应，请稍后重试。', res.status) }
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('session-expired'))
    const code = record(value) && record(value.error) ? String(value.error.code) : ''
    throw new ApiError(path === '/auth/login' && res.status === 401 ? '用户名或密码错误，请重新登录。' : messages[code] ?? (code.startsWith('SCHEDULE_') || ['TASK_BUSY','TASK_ACTIVE','SCHEDULER_TICK_FAILED'].includes(code) ? scheduleReason(code) : undefined) ?? (res.status === 401 ? '登录已失效，请重新登录。' : res.status === 429 ? '操作过于频繁，请稍后重试。' : `请求未完成（${res.status}），请重试。`), res.status)
  }
  return value
}
export const active = (r: Run) => ['QUEUED','RUNNING','RECOVERING'].includes(r.status)
export const text = (v: unknown, fallback = '—'): string => typeof v === 'string' || typeof v === 'number' ? String(v) : fallback
export const safeUrl = (v: unknown): string | undefined => { try { const u = new URL(String(v)); return ['http:', 'https:'].includes(u.protocol) ? u.href : undefined } catch { return undefined } }
export const labels: Record<string,string> = { QUEUED:'排队中', RUNNING:'采集中', RECOVERING:'恢复中', SUCCEEDED:'已完成', PARTIAL:'部分完成', FAILED:'失败', CANCELLED:'已取消', SKIPPED:'已跳过', manual:'手动', scheduled:'每日计划', pending:'待采集', completed:'已采集', failed:'采集失败', COLLECT:'采集', SEAL:'封存', UPLOAD:'入库', MANUAL:'人工模式', AUTO:'自动模式', MANUAL_REQUESTED:'等待人工模式', PAUSED:'已暂停', IDLE:'空闲' }
export const label = (v: unknown) => labels[text(v)] ?? text(v)
export const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('zh-CN') : '—'
