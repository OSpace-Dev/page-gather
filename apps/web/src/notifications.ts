import { ApiError, api, identified, page, record, row } from './api.ts'

export const appRoutes = ['/overview', '/tasks', '/runs', '/entities', '/notifications', '/notification-settings'] as const
export const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v)
export interface RuleInput { name: string; enabled: boolean; taskIds: string[]; eventTypes: string[]; keywords: string[]; pushEnabled: boolean }
export interface NotificationRule extends RuleInput { id: string }
export interface NotificationItem { id: string; kind: string; title: string; createdAt: string; readAt: string | null; runId: string | null; entityId: string | null; versionId: string | null }
export interface DeliverySummary { pending:number; retry:number; sending:number; accepted:number; failed:number; skipped:number }
export interface NotificationDetail extends NotificationItem { body: string; delivery: DeliverySummary }
export interface Device { id: string; deviceLabel: string; enabled: boolean; owned: boolean; createdAt: string; updatedAt: string }
export interface PushConfig { configured: boolean; publicKey: string | null; enabled: boolean; reason: string | null }
export interface PushStatus { enabled: boolean; healthy: boolean; pending: number; retry: number; accepted: number; failed: number; lastErrorCode: string | null }
const invalid = (name: string): never => { throw new ApiError(`${name}接口数据格式不匹配，请重试或联系管理员。`) }
const nullableString = (v: unknown) => v === null || typeof v === 'string'
const timestamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const stringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
export function ruleError(v: RuleInput): string {
  if (!v.name.trim() || v.name.trim().length > 200) return '规则名称需为 1–200 字。'
  if (typeof v.enabled !== 'boolean' || typeof v.pushEnabled !== 'boolean') return '规则开关格式错误。'
  if (!stringArray(v.taskIds) || v.taskIds.length > 100 || !v.taskIds.every(validId) || new Set(v.taskIds).size !== v.taskIds.length) return '任务标识无效、重复或超过 100 项。'
  if (!stringArray(v.eventTypes) || !v.eventTypes.length || !v.eventTypes.every(x => ['baseline', 'created', 'changed'].includes(x)) || new Set(v.eventTypes).size !== v.eventTypes.length) return '请选择不重复的基线、新增或变化事件。'
  if (!stringArray(v.keywords) || v.keywords.length > 100 || v.keywords.some(x => !x.trim() || x.length > 200) || new Set(v.keywords).size !== v.keywords.length) return '关键词需为不重复的 1–200 字，最多 100 项。'
  return ''
}
export function parseRule(v: unknown): NotificationRule {
  const r = identified(v)
  if (!validId(r.id) || typeof r.name !== 'string' || typeof r.enabled !== 'boolean' || typeof r.pushEnabled !== 'boolean' || !stringArray(r.taskIds) || !stringArray(r.eventTypes) || !stringArray(r.keywords)) return invalid('规则')
  const result = r as unknown as NotificationRule
  if (ruleError(result)) return invalid('规则')
  return result
}
export function parseNotification(v: unknown): NotificationItem {
  const r = identified(v)
  if (!validId(r.id) || typeof r.kind !== 'string' || !['baseline', 'created', 'changed', 'test'].includes(r.kind) || typeof r.title !== 'string' || !timestamp(r.createdAt) || !(r.readAt === null || timestamp(r.readAt)) || ![r.runId, r.entityId, r.versionId].every(x => x === null || validId(x))) return invalid('通知')
  return { id:r.id, kind:r.kind, title:r.title, createdAt:r.createdAt as string, readAt:r.readAt as string|null, runId:r.runId as string|null, entityId:r.entityId as string|null, versionId:r.versionId as string|null }
}
export function parseDelivery(v: unknown): DeliverySummary {
  const r = row(v)
  if (!['pending','retry','sending','accepted','failed','skipped'].every(k=>Number.isSafeInteger(r[k]) && Number(r[k])>=0)) return invalid('投递摘要')
  return {pending:Number(r.pending),retry:Number(r.retry),sending:Number(r.sending),accepted:Number(r.accepted),failed:Number(r.failed),skipped:Number(r.skipped)}
}
export function parseDetail(v: unknown): NotificationDetail {
  const r = row(row(v).notification), item = parseNotification(r)
  if (typeof r.body !== 'string') return invalid('通知详情')
  return { ...item, body: r.body, delivery:parseDelivery(r.delivery) }
}
export function parseDevice(v: unknown): Device {
  const r = identified(v)
  if (!validId(r.id) || typeof r.deviceLabel !== 'string' || typeof r.enabled !== 'boolean' || typeof r.owned !== 'boolean' || !timestamp(r.createdAt) || !timestamp(r.updatedAt) || 'endpoint' in r || 'keys' in r || 'auth' in r || 'p256dh' in r) return invalid('设备')
  return { id:r.id, deviceLabel:r.deviceLabel, enabled:r.enabled, owned:r.owned, createdAt:r.createdAt, updatedAt:r.updatedAt }
}
export function parsePushConfig(v: unknown): PushConfig {
  const r = row(v)
  if (typeof r.configured !== 'boolean' || typeof r.enabled !== 'boolean' || !nullableString(r.publicKey) || !nullableString(r.reason) || (r.configured ? (typeof r.publicKey !== 'string' || !r.publicKey) : r.publicKey !== null)) return invalid('推送配置')
  return { configured:r.configured, publicKey:r.publicKey as string|null, enabled:r.enabled, reason:r.reason as string|null }
}
export function parsePushStatus(v: unknown): PushStatus {
  const r = row(v)
  const counts = parseDelivery(r.counts)
  if (typeof r.enabled !== 'boolean' || typeof r.healthy !== 'boolean' || !nullableString(r.lastErrorCode)) return invalid('投递状态')
  return { enabled:r.enabled, healthy:r.healthy, pending:Number(counts.pending), retry:Number(counts.retry), accepted:Number(counts.accepted), failed:Number(counts.failed), lastErrorCode:r.lastErrorCode as string|null }
}
export function parseCount(v: unknown): number { const r = row(v); if (!Number.isSafeInteger(r.count) || Number(r.count) < 0) return invalid('未读数量'); return Number(r.count) }
export function notificationLink(id: unknown): string | undefined { return validId(id) ? `/notifications?id=${encodeURIComponent(id)}` : undefined }
export function originalTarget(n: NotificationItem): string | undefined {
  if (!n.runId || !validId(n.runId)) return undefined
  const params = new URLSearchParams({runId:n.runId})
  if (n.entityId || n.versionId) {
    if (!validId(n.entityId) || !validId(n.versionId)) return undefined
    params.set('entityId',n.entityId); params.set('versionId',n.versionId)
  }
  return `/runs?${params}`
}
// 统一旧query别名；冲突、数组或空值不能静默变成“没有详情”。
export function notificationQueryId(query: Record<string,unknown>): string {
  const values = [query.id,query.notificationId].filter(v=>v !== undefined)
  if (!values.length) return ''
  if (!values.every(validId) || new Set(values).size !== 1) return invalid('通知标识')
  return values[0] as string
}
export function currentOwnedDevice(devices: Device[], id: string|null, enabled = false): Device {
  if (!id || !validId(id)) throw new ApiError('请先主动订阅或重新登记本机；本地设备标识不代表当前会话归属。')
  const device = devices.find(d=>d.id===id)
  if (!device || !device.owned) throw new ApiError('本机订阅尚未绑定当前登录会话，请点击重新登记本机订阅后重试；未操作其他设备。')
  if (enabled && !device.enabled) throw new ApiError('本机订阅已停用，请重新登记本机后再测试。')
  return device
}
export function fixedVersion(history: Record<string,unknown>[], versionId: string, entityId: string, runId = ''): Record<string,unknown> {
  if (!validId(versionId) || !validId(entityId) || (runId && !validId(runId))) return invalid('历史版本目标')
  const version = history.find(v=>v.id===versionId)
  if (!version) throw new ApiError('通知指向的历史版本不存在或已不可访问，未显示最新版本替代。')
  if (version.entityId !== entityId || (runId && version.runId !== runId) || !record(version.readme) || version.readme.format !== 'rendered_text' || !(version.readme.status === 'found' && typeof version.readme.text === 'string' || version.readme.status === 'not_found' && version.readme.text === null)) return invalid('原运行历史版本')
  return version
}
export function loginRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020%#]/.test(value.split('?')[0]!)) return '/overview'
  try {
    const u = new URL(value, 'https://app.invalid')
    if (u.origin !== 'https://app.invalid' || !appRoutes.some(p => p === u.pathname)) return '/overview'
    const allowed: Record<string, string[]> = { '/notifications':['id','notificationId'], '/runs':['runId','entityId','versionId'], '/entities':['entityId','versionId'] }
    for (const [k,v] of u.searchParams) if (!allowed[u.pathname]?.includes(k) || !validId(v) || u.searchParams.getAll(k).length !== 1) return '/overview'
    if (u.hash) return '/overview'
    if (u.pathname === '/notifications') { const id = notificationQueryId(Object.fromEntries(u.searchParams)); return id ? notificationLink(id)! : '/notifications' }
    return u.pathname + u.search
  } catch { return '/overview' }
}
export function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalid('推送公钥')
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4-value.length%4)%4))
  const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0))
  if (bytes.length !== 65 || bytes[0] !== 4) return invalid('推送公钥')
  return bytes
}
export function subscriptionBody(value: unknown, deviceLabel: string) {
  const s = row(value)
  if (typeof s.endpoint !== 'string' || !record(s.keys) || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string' || !(s.expirationTime === null || (typeof s.expirationTime === 'number' && Number.isFinite(s.expirationTime)))) return invalid('浏览器订阅')
  // 仅作为请求体传输，不写入任何持久存储或日志；服务端继续执行域名与网络校验。
  return { subscription:{ endpoint:s.endpoint, keys:{ p256dh:s.keys.p256dh, auth:s.keys.auth }, expirationTime:s.expirationTime }, deviceLabel:deviceLabel.trim().slice(0,80) || '本机浏览器' }
}
export function notificationPage<T>(value: unknown, parse: (value:unknown)=>T) {
  const r = row(value)
  if (!(r.nextCursor === null || typeof r.nextCursor === 'string')) return invalid('分页')
  return page(r,parse)
}
export const notificationsClient = {
  async list(params: URLSearchParams) { return notificationPage(await api(`/notifications?${params}`), parseNotification) },
  async detail(id: string) { return parseDetail(await api(`/notifications/${encodeURIComponent(id)}`)) },
  async read(id: string) { const n = parseDetail(await api(`/notifications/${encodeURIComponent(id)}`, 'PATCH', { read:true })); if (n.id !== id || n.readAt === null) return invalid('已读确认'); return n },
  async readAll() { return parseCount(await api('/notifications/read-all','POST',{})) },
  async unread() { return parseCount(await api('/notifications/unread-count')) },
  async rules() { return notificationPage(await api('/notification-rules?limit=200'), parseRule) },
  async devices() { return notificationPage(await api('/push/subscriptions?limit=200'), parseDevice) }
}
