import { check, object } from './errors.js';

export const DAY = 86400000;
export const DEFAULT_SCHEDULE = Object.freeze({ enabled: false, time: '09:00', timezone: 'Asia/Shanghai' });
// 所有缓存均有界；只在计算计划时使用Intl，不常驻逐分钟扫描。
const formatters = new Map();
const slots = new Map();
function cache(map, key, value, limit) {
  if (map.size >= limit) map.delete(map.keys().next().value);
  map.set(key, value); return value;
}
function formatter(zone) {
  if (formatters.has(zone)) return formatters.get(zone);
  return cache(formatters, zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }), 64);
}
export function scheduleInput(value = DEFAULT_SCHEDULE) {
  check(object(value) && Object.keys(value).length === 3 && Object.keys(value).every(k => ['enabled','time','timezone'].includes(k)), 'INVALID_SCHEDULE', 400);
  check(typeof value.enabled === 'boolean' && typeof value.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time), 'INVALID_SCHEDULE', 400);
  check(typeof value.timezone === 'string' && value.timezone.length <= 100 && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value.timezone), 'INVALID_TIMEZONE', 400);
  try { formatter(value.timezone); } catch { check(false, 'INVALID_TIMEZONE', 400); }
  return { enabled: value.enabled, time: value.time, timezone: value.timezone };
}
function local(ms, zone) {
  const p = Object.fromEntries(formatter(zone).formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
export function localDate(ms, zone) { return new Date(local(ms, zone)).toISOString().slice(0,10); }
export function addDate(date, days) { return new Date(Date.parse(date + 'T00:00:00Z') + days * DAY).toISOString().slice(0,10); }
// 枚举日期附近的offset；若分钟落在跳时空洞，二分找到offset跃迁的首个有效分钟。
// 6小时采样、最多17段与每段约9次二分，运行量不随离线年份增长。
export function slotForDate(date, schedule) {
  const key = `${schedule.timezone}|${date}|${schedule.time}`;
  if (slots.has(key)) return slots.get(key);
  const target = Date.parse(`${date}T${schedule.time}:00Z`);
  const offsets = new Set(); const transitions = [];
  const offset = ms => local(ms, schedule.timezone) - ms;
  let previous = target - 2 * DAY; let before = offset(previous); offsets.add(before);
  for (let ms = previous + 21600000; ms <= target + 2 * DAY; ms += 21600000) {
    const after = offset(ms); offsets.add(after);
    if (after !== before) {
      let lo = previous; let hi = ms;
      while (hi - lo > 60000) { const mid = Math.floor((lo + hi) / 120000) * 60000; if (offset(mid) === before) lo = mid; else hi = mid; }
      transitions.push(hi);
    }
    previous = ms; before = after;
  }
  const exact = [...offsets].map(o => target - o).filter(ms => local(ms, schedule.timezone) === target);
  let result = exact.length ? Math.min(...exact) : null;
  if (result === null) {
    const candidates = transitions.filter(ms => localDate(ms, schedule.timezone) === date && local(ms, schedule.timezone) >= target);
    candidates.sort((a,b) => local(a, schedule.timezone) - local(b, schedule.timezone) || a-b);
    result = candidates[0] ?? null; // 整个当地日期不存在时不造一个别日slot。
  }
  return cache(slots, key, result, 2048);
}
export function nextSlot(schedule, after) {
  const date = localDate(after, schedule.timezone);
  for (let day = 0; day < 4; day++) {
    const localDay = addDate(date, day); const ms = slotForDate(localDay, schedule);
    if (ms !== null && ms > after) return { ms, date: localDay };
  }
  throw new Error('SCHEDULE_DATE_UNAVAILABLE');
}
export function latestSlot(schedule, now) {
  const date = localDate(now, schedule.timezone);
  for (let day = 0; day < 4; day++) {
    const localDay = addDate(date, -day); const ms = slotForDate(localDay, schedule);
    if (ms !== null && ms <= now) return { ms, date: localDay };
  }
  throw new Error('SCHEDULE_DATE_UNAVAILABLE');
}
