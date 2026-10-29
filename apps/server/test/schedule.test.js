import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleInput, slotForDate, nextSlot, latestSlot, DEFAULT_SCHEDULE } from '../schedule.js';

const iso = ms => new Date(ms).toISOString();
const schedule = (time, timezone) => ({ enabled: true, time, timezone });

test('IANA验证、严格schedule字段、HH:mm；禁用配置同样验证', () => {
  assert.deepEqual(scheduleInput(), DEFAULT_SCHEDULE);
  for (const value of [null, {}, { ...DEFAULT_SCHEDULE, extra: true }, { ...DEFAULT_SCHEDULE, enabled: 1 }, { ...DEFAULT_SCHEDULE, time: '9:00' }, { ...DEFAULT_SCHEDULE, time: '24:00' }, { ...DEFAULT_SCHEDULE, time: '09:60' }]) assert.throws(() => scheduleInput(value), e => e.code === 'INVALID_SCHEDULE');
  for (const timezone of ['Mars/Olympus', '+08:00', '', 'America/New_York/invalid', null]) assert.throws(() => scheduleInput({ ...DEFAULT_SCHEDULE, timezone }), e => e.code === 'INVALID_TIMEZONE');
  for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu']) assert.equal(scheduleInput(schedule('09:00', timezone)).timezone, timezone);
});

test('Shanghai/UTC、纽约缺失顺延03:00及重复选早、Lord Howe半小时、跨年闰日', () => {
  const cases = [
    ['2026-10-29', '09:00', 'Asia/Shanghai', '2026-10-29T01:00:00.000Z'],
    ['2026-10-29', '09:00', 'UTC', '2026-10-29T09:00:00.000Z'],
    ['2026-03-08', '02:30', 'America/New_York', '2026-03-08T07:00:00.000Z'],
    ['2026-11-01', '01:30', 'America/New_York', '2026-11-01T05:30:00.000Z'],
    ['2026-10-04', '02:15', 'Australia/Lord_Howe', '2026-10-03T15:30:00.000Z'],
    ['2026-04-05', '01:45', 'Australia/Lord_Howe', '2026-04-04T14:45:00.000Z'],
    ['2027-01-01', '00:15', 'Asia/Shanghai', '2026-12-31T16:15:00.000Z'],
    ['2028-02-29', '09:00', 'UTC', '2028-02-29T09:00:00.000Z'],
    ['2026-10-29', '09:00', 'Asia/Kathmandu', '2026-10-29T03:15:00.000Z']
  ];
  for (const [date, time, zone, expected] of cases) {
    const config = schedule(time, zone);
    assert.equal(iso(slotForDate(date, config)), expected, `${date}/${zone}/${time}`);
    assert.equal(iso(slotForDate(date, config)), expected, 'cached');
  }
  const ny = schedule('01:30', 'America/New_York');
  assert.equal(iso(nextSlot(ny, Date.parse('2026-11-01T05:45Z')).ms), '2026-11-02T06:30:00.000Z');
  assert.equal(iso(latestSlot(ny, Date.parse('2026-11-01T06:45Z')).ms), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(nextSlot(schedule('09:00','UTC'), Date.parse('2028-02-28T10:00Z')).ms), '2028-02-29T09:00:00.000Z');
  assert.equal(iso(nextSlot(schedule('00:15','Asia/Shanghai'), Date.parse('2026-12-31T16:15Z')).ms), '2027-01-01T16:15:00.000Z');
  const apia = schedule('09:00', 'Pacific/Apia');
  assert.equal(slotForDate('2011-12-30', apia), null);
  assert.equal(nextSlot(apia, Date.parse('2011-12-29T20:00Z')).date, '2011-12-31');
});
