// 有界串行Outbox；HTTP accepted不等于手机展示成功。所有外部异常都折叠为固定诊断码。
const errorCodes = new Set(['PUSH_TIMEOUT','PUSH_ABORTED','PUSH_NETWORK_ERROR','PUSH_ENDPOINT_REJECTED','PUSH_DNS_REJECTED','PUSH_DNS_BLOCKED','PUSH_DNS_FAILED','PUSH_INVALID_SUBSCRIPTION','PUSH_REDIRECT_REJECTED','PUSH_NOT_CONFIGURED','PUSH_DISABLED']);
export const MAX_RETRY_AFTER_MS = 3600000;
export function retryAfter(headers, now) {
  const value = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delay)) : 0;
}
export function deliveryResult(result, attempts, now) {
  const status = Number(result?.statusCode);
  if (status >= 200 && status < 300) return { status: 'accepted', code: 'PUSH_SERVICE_ACCEPTED' };
  if ([404,410].includes(status)) return { status: 'failed', code: 'PUSH_SUBSCRIPTION_GONE', remove: true };
  const transient = status === 429 || status >= 500 && status <= 599 || !status;
  const code = status === 429 ? 'PUSH_RATE_LIMITED' : status >= 500 && status <= 599 ? 'PUSH_SERVICE_UNAVAILABLE' : status === 401 || status === 403 ? 'PUSH_AUTH_REJECTED' : status === 413 ? 'PUSH_PAYLOAD_TOO_LARGE' : errorCodes.has(result?.code) ? result.code : 'PUSH_DELIVERY_FAILED';
  // 安全校验失败不可盲目重试；仅网络、超时、429和5xx可重试。
  const retryable = transient && (!result?.code || ['PUSH_TIMEOUT','PUSH_NETWORK_ERROR','PUSH_DNS_FAILED'].includes(result.code) || status === 429 || status >= 500);
  if (retryable && attempts < 5) return { status: 'retry', code, delay: Math.max(Math.min(60000 * 2 ** (attempts - 1), MAX_RETRY_AFTER_MS), retryAfter(result.headers, now)) };
  return { status: 'failed', code };
}
export class Dispatcher {
  constructor(notifications, transport, { timeoutMs = 15000, leaseMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isFinite(leaseMs) || leaseMs <= timeoutMs || leaseMs > 120000) throw new Error('INVALID_DISPATCHER_OPTIONS');
    this.notifications = notifications; this.transport = transport; this.timeoutMs = timeoutMs; this.leaseMs = leaseMs;
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.timer = null; this.stopped = true; this.running = null; this.controller = null; this.failures = 0;
    this.state = { healthy: true, running: false, lastTickAt: null, lastErrorCode: null, nextWakeAt: null };
    this.wake = () => {
      if (this.stopped) return;
      if (!this.enabled()) {
        if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; this.state.nextWakeAt = null;
        this.controller?.abort(); return;
      }
      if (!this.running && !this.failures) this.arm(0);
    };
  }
  enabled() { return !!(this.notifications.config.enabled && this.notifications.config.configured); }
  status() { return { enabled: this.enabled(), ...this.state, counts: this.notifications.counts() }; }
  start() {
    if (!this.stopped) return;
    this.stopped = false; this.notifications.onChange = this.wake;
    if (this.enabled()) this.arm(0);
  }
  arm(delay) {
    if (this.stopped || !this.enabled()) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.state.nextWakeAt = new Date(this.notifications.store.now() + delay).toISOString();
    this.timer = this.setTimer(() => { this.timer = null; void this.run(); }, delay); this.timer?.unref?.();
  }
  // 一轮最多一条，确保事件循环能处理禁用规则/注销/关闭；循环不扫描忙等。
  run() {
    if (this.running) return this.running;
    if (this.stopped || !this.enabled()) return Promise.resolve();
    if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; this.state.nextWakeAt = null;
    this.running = this.step().finally(() => {
      this.running = null; this.state.running = false;
      if (!this.stopped) {
        let delay = 60000;
        try {
          const due = this.notifications.nextDeliveryAt();
          delay = this.failures ? Math.min(60000, 1000 * 2 ** Math.min(this.failures - 1, 6)) : due === null ? 60000 : Math.min(60000, Math.max(0, due - this.notifications.store.now()));
        } catch { this.state.healthy = false; this.state.lastErrorCode = 'PUSH_DISPATCHER_FAILED'; this.failures++; }
        this.arm(delay);
      }
    });
    return this.running;
  }
  async step() {
    try {
      const row = this.notifications.claimDelivery(this.leaseMs);
      this.state.lastTickAt = this.notifications.store.iso();
      if (this.state.lastErrorCode === 'PUSH_DISPATCHER_FAILED') this.state.lastErrorCode = null;
      if (row) {
        this.state.running = true;
        const result = await this.send(row);
        // 停止后保留持久lease给重启回收，不让已关闭流程再写DB。
        if (!this.stopped && this.enabled()) {
          const decision = deliveryResult(result, row.attempts, this.notifications.store.now());
          this.notifications.finishDelivery(row, decision);
          this.state.lastErrorCode = decision.status === 'accepted' ? null : decision.code;
        }
      }
      this.state.healthy = true; this.failures = 0;
    } catch {
      this.state.healthy = false; this.state.lastErrorCode = 'PUSH_DISPATCHER_FAILED'; this.failures++;
    }
  }
  async send(row) {
    const controller = new AbortController(); this.controller = controller;
    let timer; let abortHandler;
    const bounded = new Promise(resolve => {
      abortHandler = () => { this.clearTimer(timer); resolve({ code: this.stopped ? 'PUSH_ABORTED' : 'PUSH_TIMEOUT' }); };
      controller.signal.addEventListener('abort', abortHandler, { once: true });
      timer = this.setTimer(() => controller.abort(), this.timeoutMs);
    });
    // 只传通用锁屏摘要与本应用路径，不泄露README/项目名。
    const payload = { notificationId: row.notification_id, kind: row.notification.kind, title: row.notification.kind === 'test' ? '推送测试' : '有新的站内通知', body: '打开应用查看详情', targetPath: `/notifications?id=${encodeURIComponent(row.notification_id)}`, tag: row.notification_id };
    const operation = Promise.resolve().then(() => controller.signal.aborted ? { code: 'PUSH_ABORTED' } : this.transport({ subscription: row.subscription, payload, notificationId: row.notification_id, signal: controller.signal })).catch(error => ({ code: error?.code, statusCode: error?.statusCode, headers: error?.headers ?? (Number.isFinite(error?.safeRetryAfter) ? { 'retry-after': String(error.safeRetryAfter) } : undefined) }));
    try { return await Promise.race([operation, bounded]); }
    finally { this.clearTimer(timer); controller.signal.removeEventListener('abort', abortHandler); if (this.controller === controller) this.controller = null; }
  }
  stop() {
    this.stopped = true; this.state.nextWakeAt = null;
    if (this.timer !== null) this.clearTimer(this.timer); this.timer = null;
    if (this.notifications.onChange === this.wake) this.notifications.onChange = null;
    this.controller?.abort();
    return this.running ?? Promise.resolve();
  }
}
