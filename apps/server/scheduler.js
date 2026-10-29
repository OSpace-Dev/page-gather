// 单中心低频维护循环；SQLite事务与唯一slot约束仍是并发/重启幂等边界。
export class Scheduler {
  constructor(store, { now = store.now, setTimer = setTimeout, clearTimer = clearTimeout, onError = () => console.error('SCHEDULER_TICK_FAILED') } = {}) {
    this.store = store; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer; this.onError = onError;
    this.timer = null; this.stopped = true; this.failures = 0;
    this.state = { enabled: true, healthy: false, lastTickAt: null, lastErrorCode: null, nextWakeAt: null, stats: { due: 0, created: 0, skipped: 0 } };
    this.wake = () => { if (!this.stopped && !this.failures) this.arm(0); };
  }
  status() { return { ...this.state, stats: { ...this.state.stats } }; }
  start() { if (!this.stopped) return; this.stopped = false; this.store.onScheduleChange = this.wake; this.run(); }
  arm(delay) {
    if (this.stopped) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.state.nextWakeAt = new Date(this.now() + delay).toISOString();
    this.timer = this.setTimer(() => { this.timer = null; this.run(); }, delay); this.timer?.unref?.();
  }
  run() {
    if (this.stopped) return;
    let delay;
    try {
      const now = this.now(); const stats = this.store.tick(now);
      const next = this.store.nextScheduledAt();
      delay = next ? Math.min(60000, Math.max(1, Date.parse(next) - now)) : 60000;
      this.state.lastTickAt = new Date(now).toISOString(); this.state.lastErrorCode = null; this.state.healthy = true;
      for (const key of Object.keys(stats)) this.state.stats[key] += stats[key];
      this.failures = 0;
    } catch {
      this.failures++;
      this.state.healthy = false; this.state.lastErrorCode = 'SCHEDULER_TICK_FAILED';
      delay = Math.min(60000, 1000 * 2 ** Math.min(this.failures - 1, 6));
      this.onError(this.state.lastErrorCode);
    }
    this.arm(delay);
  }
  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null; this.state.nextWakeAt = null;
    if (this.store.onScheduleChange === this.wake) this.store.onScheduleChange = null;
  }
}
