export interface Schedule { enabled: boolean; time: string; timezone: string }
export const defaultSchedule = (): Schedule => ({ enabled: false, time: '09:00', timezone: 'Asia/Shanghai' })
export const timezoneOptions = ['Asia/Shanghai', 'UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/London'].map(value => ({ label: value, value }))
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function scheduleError(v: unknown): string {
  if (!object(v) || typeof v.enabled !== 'boolean') return '每日计划启用状态必须明确为开或关。'
  if (typeof v.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) return '请输入有效的 HH:mm 时间（00:00–23:59）。'
  // 与服务端 scheduleInput 保持一致；Intl 接受别名，读取时保留用户原始值。
  if (typeof v.timezone !== 'string' || v.timezone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(v.timezone)) return '请输入有效的 IANA 时区，例如 Asia/Shanghai 或 UTC。'
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: v.timezone }).format(0) } catch { return '当前浏览器不支持此时区，请检查 IANA 名称。' }
  return ''
}
export function parseSchedule(v: unknown): Schedule {
  // 兼容 P2：缺少日程绝不推断为启用；存在但畸形的 DTO 不静默覆盖。
  if (v === undefined) return defaultSchedule()
  if (scheduleError(v)) throw new Error('每日计划数据格式不匹配。')
  const s = v as Schedule
  return { enabled: s.enabled, time: s.time, timezone: s.timezone }
}
// 绝对时刻必须带偏移，不能把无时区文本按浏览器本地时间解释。
export function scheduleDate(value: unknown, timezone = 'UTC'): string {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) return '—'
  try {
    return `${new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value))} [${timezone}]`
  } catch { return '—' }
}
const reasons: Record<string, string> = {
  SCHEDULE_CHANGED: '每日计划已修改或停用，旧计划不再执行', SCHEDULE_EXPIRED: '计划时刻已超过 24 小时，已跳过',
  TASK_BUSY: '同一任务已有运行，本次计划已跳过', TASK_DISABLED: '任务已停用', SCHEDULE_DISABLED: '每日计划已关闭',
  TASK_ACTIVE: '同一任务已有运行，本次计划已跳过', SCHEDULE_MISSED: '较早日程已跳过，仅补最近一次',
  SCHEDULE_DUPLICATE: '此计划时刻已处理，不重复执行', INVALID_SCHEDULE: '每日计划时间或时区不符合服务端要求',
  SCHEDULER_TICK_FAILED: '调度维护失败，请稍后刷新或联系管理员检查服务日志',
  DISABLED: '自动计划已停用', SCHEDULED: '等待下一次计划',
  MISSED_WINDOW: '已超过补偿窗口', SLOT_EXISTS: '此计划时刻已处理，不重复执行'
}
export function scheduleReason(value: unknown): string {
  const code = typeof value === 'string' ? value : object(value) && typeof value.code === 'string' ? value.code : ''
  return /^[A-Z0-9_]{1,80}$/.test(code) ? `${reasons[code] ?? '状态标识'}（${code}）` : code ? '运行异常' : '—'
}
export interface SchedulerState { enabled: boolean; healthy: boolean; lastTickAt?: unknown; lastErrorCode?: unknown; nextWakeAt?: unknown; stats: Record<string, unknown> }
export function parseScheduler(value: unknown): SchedulerState {
  if (!object(value) || typeof value.enabled !== 'boolean' || typeof value.healthy !== 'boolean' || (value.stats != null && !object(value.stats))) throw new Error('调度状态数据格式不匹配。')
  return { ...value, enabled: value.enabled, healthy: value.healthy, stats: object(value.stats) ? value.stats : {} }
}
export function scheduleStatusText(value: unknown, timezone: string): string {
  if (!object(value)) return typeof value === 'string' ? scheduleReason(value) : '暂无处理记录'
  const parts: string[] = []
  for (const key of ['lastProcessedAt', 'processedAt', 'lastScheduledFor']) if (value[key]) parts.push(`上次处理：${scheduleDate(value[key], timezone)}`)
  for (const key of ['state', 'status', 'lastStatus', 'skipReason', 'lastSkipReason', 'lastReason', 'reason', 'code']) if (value[key]) parts.push(scheduleReason(value[key]))
  if (typeof value.created === 'number') parts.push(`已创建 ${value.created}`)
  if (typeof value.skipped === 'number') parts.push(`已跳过 ${value.skipped}`)
  return parts.join(' · ') || '暂无处理记录'
}
export function runScheduleText(r: Record<string, unknown>): string {
  const snapshot = object(r.taskSnapshot) ? r.taskSnapshot : object(r.snapshot) ? r.snapshot : null
  const schedule = snapshot && object(snapshot.schedule) ? snapshot.schedule : null
  const timezone = r.timezone ?? r.scheduleTimezone ?? schedule?.timezone
  const time = r.timeSnapshot ?? r.scheduleTime ?? schedule?.time
  const zone = typeof timezone === 'string' ? timezone : 'UTC'
  return `${scheduleDate(r.scheduledFor, zone)} · 当地时间快照 ${typeof time === 'string' ? time : '—'}`
}
