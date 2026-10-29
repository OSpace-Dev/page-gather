import test from 'node:test'
import assert from 'node:assert/strict'
import { active, run, task } from '../src/api.ts'
import { defaultSchedule, parseSchedule, parseScheduler, runScheduleText, scheduleDate, scheduleError, scheduleReason, scheduleStatusText } from '../src/schedule.ts'

for (const timezone of ['Asia/Shanghai', 'UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/London', 'Asia/Kolkata', 'Pacific/Chatham']) {
  for (const time of ['00:00', '09:00', '23:59']) {
    test(`合法计划 ${timezone} ${time}`, () => assert.equal(scheduleError({ enabled: true, time, timezone }), ''))
  }
}
for (const time of ['', '9:00', '24:00', '09:60', '09:00:00', ' 09:00', '09:00 ', null, 900]) {
  test(`拒绝非法时间 ${JSON.stringify(time)}`, () => assert.ok(scheduleError({ ...defaultSchedule(), time })))
}
for (const timezone of ['', 'Shanghai', 'Asia/Not_A_Zone', ' Asia/Shanghai', '+08:00', null]) {
  test(`拒绝非法时区 ${JSON.stringify(timezone)}`, () => assert.ok(scheduleError({ ...defaultSchedule(), timezone })))
}
test('启用必须是布尔值，关闭状态仍校验保存字段', () => {
  assert.ok(scheduleError({ ...defaultSchedule(), enabled: 'false' }))
  assert.ok(scheduleError({ ...defaultSchedule(), enabled: false, time: '25:00' }))
})
test('P2 DTO 缺省日程默认关闭，任务启用不代表日程启用；不修改源 DTO', () => {
  const old = { id: 'p2', name: '旧任务', enabled: true, config: {} }
  const parsed = task(old)
  assert.deepEqual(parsed.schedule, defaultSchedule())
  assert.equal(old.schedule, undefined)
  parsed.schedule.enabled = true
  assert.equal(parseSchedule(undefined).enabled, false)
  assert.throws(() => task({ ...old, schedule: null }))
  const disabled = task({ ...old, enabled: false, schedule: { ...defaultSchedule(), enabled: true } })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.schedule.enabled, true)
})
test('日程序列化仅包含三个用户字段，不回写派生字段', () => {
  assert.deepEqual(parseSchedule({ ...defaultSchedule(), scheduleRevision: 10, nextScheduledAt: 'x' }), defaultSchedule())
})
test('UTC 绝对时刻转换到明确时区，不受浏览器/进程本地时区影响', () => {
  const instant = '2026-01-01T01:00:00Z'
  assert.match(scheduleDate(instant), /01:00:00 \[UTC\]$/)
  assert.match(scheduleDate(instant, 'Asia/Shanghai'), /09:00:00 \[Asia\/Shanghai\]$/)
  assert.match(scheduleDate('2026-01-01T09:00:00+08:00'), /01:00:00 \[UTC\]$/)
  assert.equal(scheduleDate('2026-01-01T09:00:00', 'Asia/Shanghai'), '—')
  assert.equal(scheduleDate('bad'), '—')
  assert.equal(scheduleDate(null), '—')
  assert.equal(scheduleDate(instant, 'bad'), '—')
})
test('自动运行只读取历史快照的时间/时区，不混用当前任务配置', () => {
  const r = { scheduledFor: '2026-01-01T01:00:00Z', trigger: 'scheduled', taskSnapshot: { schedule: { enabled: true, time: '09:00', timezone: 'Asia/Shanghai' } }, schedule: { time: '12:00', timezone: 'UTC' } }
  assert.match(runScheduleText(r), /09:00:00 \[Asia\/Shanghai\].*当地时间快照 09:00/)
})
test('SKIPPED 是终态，支持无榜单/冻结任务快照，不等于成功也不无限轮询', () => {
  const skipped = run({ id: 'skipped', status: 'SKIPPED', trigger: 'scheduled', snapshot: { taskId: 'task', config: {} }, error: { code: 'TASK_ACTIVE' } })
  assert.equal(active(skipped), false)
  assert.equal(skipped.snapshot, undefined)
  assert.deepEqual(skipped.taskSnapshot, { taskId: 'task', config: {} })
  assert.equal(['SUCCEEDED', 'PARTIAL'].includes(skipped.status), false)
  for (const status of ['QUEUED', 'RUNNING', 'RECOVERING']) assert.equal(active(run({ id: status, status })), true)
  for (const status of ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']) assert.equal(active(run({ id: status, status })), false)
})
test('后端实际原因可读，未知 code 保留；不暴露任意错误正文', () => {
  for (const code of ['SCHEDULE_CHANGED', 'SCHEDULE_EXPIRED', 'TASK_BUSY', 'TASK_ACTIVE', 'SCHEDULE_MISSED', 'SCHEDULE_DUPLICATE']) {
    assert.ok(scheduleReason({ code }).includes(code))
    assert.ok(!scheduleReason(code).startsWith('状态标识'))
  }
  assert.equal(scheduleReason('NEW_CODE'), '状态标识（NEW_CODE）')
  assert.equal(scheduleReason('private/raw/path'), '运行异常')
  const status = scheduleStatusText({ state: 'SCHEDULED', created: 2, skipped: 1, lastReason: 'TASK_ACTIVE' }, 'UTC')
  assert.match(status, /等待下一次计划/)
  assert.match(status, /同一任务已有运行/)
  assert.match(status, /已创建 2.*已跳过 1/)
})
test('改停旧队列可返回 CANCELLED/SCHEDULE_CHANGED，过期或占用可返回 SKIPPED，均为终态且原因可读', () => {
  for (const [status, code] of [['CANCELLED', 'SCHEDULE_CHANGED'], ['SKIPPED', 'SCHEDULE_EXPIRED'], ['SKIPPED', 'TASK_BUSY']]) {
    const parsed = run({ id: `${status}-${code}`, status, error: { code } })
    assert.equal(active(parsed), false)
    assert.match(scheduleReason(parsed.error), new RegExp(code))
    assert.ok(!scheduleReason(parsed.error).startsWith('状态标识'))
  }
  assert.match(scheduleStatusText({ lastReason: 'TASK_BUSY', skipped: 1 }, 'UTC'), /同一任务已有运行.*已跳过 1/)
})
test('仅编辑 P2 config 后再次解析，日程仍默认关闭且默认对象相互隔离', () => {
  const original = { id: 'p2-config', name: '旧任务', enabled: true, config: { maxRepos: 25 } }
  const before = task(original)
  const edited = task({ ...original, config: { ...original.config, maxRepos: 30 } })
  assert.equal(before.schedule.enabled, false)
  assert.deepEqual(edited.schedule, defaultSchedule())
  assert.notEqual(before.schedule, edited.schedule)
  assert.equal(edited.config.maxRepos, 30)
})
test('调度 DTO 拒绝缺失/伪布尔健康值，真实异常保持异常', () => {
  assert.throws(() => parseScheduler({ enabled: true }))
  assert.throws(() => parseScheduler({ enabled: true, healthy: 'true' }))
  assert.equal(parseScheduler({ enabled: true, healthy: false, lastErrorCode: 'DB_ERROR', stats: { created: 2, skipped: 3 } }).healthy, false)
})
