import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../../server/store.js'
import { page, task } from '../src/api.ts'
import { defaultSchedule, scheduleError } from '../src/schedule.ts'

// 直接跨越真实 Store 与页面 DTO 解析器；只使用原生 SQLite 内存库。
function fixture(t) {
  const store = new Store({ filename: ':memory:', now: () => Date.parse('2026-06-01T08:00:00Z') })
  t.after(() => store.close())
  const base = store.list('tasks').items[0]
  const input = schedule => ({ name: '时区别名兼容测试', pluginId: base.pluginId, pluginVersion: base.pluginVersion, config: {}, enabled: true, schedule })
  return { store, base, input }
}

test('Store 创建及保存别名时区后，前端混合列表解析成功且原值不被 canonicalize', t => {
  const { store, input } = fixture(t)
  const expected = new Map()
  for (const timezone of ['GMT', 'CET', 'utc', 'Asia/Shanghai']) {
    for (const enabled of [true, false]) {
      const schedule = { enabled, time: '09:00', timezone }
      assert.equal(scheduleError(schedule), '')
      const created = store.createTask(input(schedule))
      assert.deepEqual(task(created).schedule, schedule)
      const savedSchedule = { ...schedule, time: '10:15' }
      const saved = store.patchTask(created.id, { schedule: savedSchedule })
      assert.deepEqual(task(saved).schedule, savedSchedule)
      // 日常编辑采集参数不应改动计划启用状态或时区别名。
      const configOnly = store.patchTask(created.id, { config: { maxRepos: 2 } })
      assert.deepEqual(configOnly.schedule, savedSchedule)
      if (enabled) assert.ok(Date.parse(saved.nextScheduledAt) > store.now())
      else assert.equal(saved.nextScheduledAt, null)
      expected.set(created.id, savedSchedule)
    }
  }
  const dto = store.list('tasks', { limit: 50 })
  const parsed = page(dto, task)
  assert.equal(parsed.items.length, 9)
  assert.equal(parsed.nextCursor, null)
  for (const item of parsed.items) {
    assert.deepEqual(item.schedule, expected.get(item.id) ?? defaultSchedule())
  }
  // 同时验证分页路径，避免只测单个 DTO 或自行伪造列表。
  const first = page(store.list('tasks', { limit: 4 }), task)
  const second = page(store.list('tasks', { limit: 50, cursor: first.nextCursor }), task)
  assert.deepEqual([...first.items, ...second.items], parsed.items)
})

test('真实 Store 与前端仍拒绝未知/非法时区，关闭计划也不能绕过校验', t => {
  const { store, input, base } = fixture(t)
  for (const timezone of ['Shanghai', 'Not_A_Zone', 'Asia/Not_A_Zone', '', '+08:00', ' UTC', 'UTC ', 'A'.repeat(101), null]) {
    for (const enabled of [true, false]) {
      const schedule = { enabled, time: '09:00', timezone }
      assert.ok(scheduleError(schedule), `前端应拒绝 ${JSON.stringify(timezone)}`)
      assert.throws(() => store.createTask(input(schedule)), e => e.code === 'INVALID_TIMEZONE')
      assert.throws(() => store.patchTask(base.id, { schedule }), e => e.code === 'INVALID_TIMEZONE')
    }
  }
})

test('别名时区不放宽时间校验；坏 DTO 仍使列表解析报错而非吞掉或替换', t => {
  const { store, input, base } = fixture(t)
  for (const time of ['', '9:00', '24:00', '09:60', '09:00:00', ' 09:00', null, 900]) {
    for (const enabled of [true, false]) {
      const schedule = { enabled, time, timezone: 'GMT' }
      assert.ok(scheduleError(schedule))
      assert.throws(() => store.createTask(input(schedule)), e => e.code === 'INVALID_SCHEDULE')
      assert.throws(() => store.patchTask(base.id, { schedule }), e => e.code === 'INVALID_SCHEDULE')
    }
  }
  const dto = store.list('tasks')
  for (const schedule of [null, { enabled: false, time: '24:00', timezone: 'GMT' }, { enabled: false, time: '09:00', timezone: 'Shanghai' }]) {
    const bad = { ...dto, items: [...dto.items, { ...base, id: 'bad-dto', schedule }] }
    assert.throws(() => page(bad, task), /每日计划数据格式不匹配/)
    assert.equal(bad.items.at(-1).schedule, schedule)
  }
  const configOnly = task(store.patchTask(base.id, { config: { maxRepos: 3 } }))
  assert.deepEqual(configOnly.schedule, defaultSchedule())
})
