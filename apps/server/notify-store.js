import { randomUUID, createHash, ECDH } from 'node:crypto';
import { check, key, object } from './errors.js';

const json = JSON.stringify;
const parse = row => row ? JSON.parse(row.doc) : null;
const digest = value => createHash('sha256').update(value).digest('hex');
const fields = ['name', 'enabled', 'taskIds', 'eventTypes', 'keywords', 'pushEnabled'];
const active = "status IN ('pending','retry','sending')";
export const DISABLED_PUSH = Object.freeze({ enabled: false, configured: false, publicKey: null, reason: 'PUSH_DISABLED' });

// 只校验允许的公开推送服务；DNS/重定向及发送时的地址校验由transport再次执行。
export function subscriptionInput(input) {
  check(object(input) && Object.keys(input).every(k => ['endpoint','keys','expirationTime'].includes(k)), 'INVALID_SUBSCRIPTION', 400);
  let url;
  try { url = new URL(input.endpoint); } catch { check(false, 'INVALID_PUSH_ENDPOINT', 400); }
  const host = url.hostname;
  check(typeof input.endpoint === 'string' && input.endpoint.length <= 2048 && !/[\s\x00-\x1f\x7f#]/.test(input.endpoint) && url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') &&
    (host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') || host === 'web.push.apple.com' || host.endsWith('.push.apple.com')), 'INVALID_PUSH_ENDPOINT', 400);
  check(object(input.keys) && Object.keys(input.keys).length === 2, 'INVALID_SUBSCRIPTION_KEYS', 400);
  for (const [name, length] of [['p256dh',65],['auth',16]]) {
    const value = input.keys[name];
    check(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').length === length && Buffer.from(value, 'base64url').toString('base64url') === value, 'INVALID_SUBSCRIPTION_KEYS', 400);
  }
  check(Buffer.from(input.keys.p256dh, 'base64url')[0] === 4, 'INVALID_SUBSCRIPTION_KEYS', 400);
  try { ECDH.convertKey(Buffer.from(input.keys.p256dh, 'base64url'), 'prime256v1'); } catch { check(false, 'INVALID_SUBSCRIPTION_KEYS', 400); }
  check(input.expirationTime == null || Number.isSafeInteger(input.expirationTime) && input.expirationTime > 0, 'INVALID_SUBSCRIPTION', 400);
  return { endpoint: url.href, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth }, expirationTime: input.expirationTime ?? null };
}

export class NotifyStore {
  constructor(store, config = DISABLED_PUSH) {
    this.store = store; this.db = store.db; this.config = config; this.onChange = null;
    store.tx(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS notification_rules(id TEXT PRIMARY KEY, doc TEXT NOT NULL CHECK(json_valid(doc)));
        CREATE TABLE IF NOT EXISTS notifications(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, dedupe_key TEXT NOT NULL UNIQUE, doc TEXT NOT NULL CHECK(json_valid(doc)));
        CREATE TABLE IF NOT EXISTS push_subscriptions(id TEXT PRIMARY KEY, endpoint_hash TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, secret TEXT CHECK(secret IS NULL OR json_valid(secret)), doc TEXT NOT NULL CHECK(json_valid(doc)));
        CREATE TABLE IF NOT EXISTS notification_outbox(notification_id TEXT PRIMARY KEY REFERENCES notifications(id), rule_ids TEXT NOT NULL CHECK(json_valid(rule_ids)), kind TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS push_deliveries(notification_id TEXT NOT NULL REFERENCES notification_outbox(notification_id), subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id), status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT, last_code TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(notification_id,subscription_id));
        CREATE INDEX IF NOT EXISTS push_delivery_due ON push_deliveries(status,due_at,lease_until);
        CREATE TABLE IF NOT EXISTS push_test_requests(request_key TEXT PRIMARY KEY, notification_id TEXT NOT NULL REFERENCES notifications(id), subscription_id TEXT);
        CREATE TABLE IF NOT EXISTS notification_migrations(id TEXT PRIMARY KEY);`);
      if (!this.db.prepare('PRAGMA table_info(push_test_requests)').all().some(c => c.name === 'subscription_id')) this.db.exec('ALTER TABLE push_test_requests ADD COLUMN subscription_id TEXT');
      // 独立迁移标记：旧events与baseline不回放，用户删完规则后重启也不复活默认规则。
      if (!this.db.prepare("SELECT id FROM notification_migrations WHERE id='p4'").get()) {
        const at = store.iso(); const rule = { id: randomUUID(), name: '全部站内通知', enabled: true, taskIds: [], eventTypes: ['baseline','created','changed'], keywords: [], pushEnabled: false, createdAt: at, updatedAt: at };
        this.db.prepare('INSERT INTO notification_rules VALUES(?,?)').run(rule.id, json(rule));
        this.db.prepare("INSERT INTO notification_migrations VALUES('p4')").run();
      }
      // 全局关闭/配置失效的重启同样撤销旧pending；disabled循环不留历史待以后开启发送。
      this.prunePending();
    });
  }
  configure(config) {
    const previous = this.config;
    try { this.store.tx(() => { this.config = config; this.prunePending(); }); }
    catch (error) { this.config = previous; throw error; }
    this.wake();
  }
  reconcile() { this.store.tx(() => this.prunePending()); }
  wake() { this.onChange?.(); }
  rules() { return { items: this.db.prepare('SELECT doc FROM notification_rules ORDER BY rowid').all().map(parse), nextCursor: null }; }
  rule(id) { const rule = parse(this.db.prepare('SELECT doc FROM notification_rules WHERE id=?').get(id)); check(rule, 'RULE_NOT_FOUND', 404); return rule; }
  ruleInput(input, previous = {}) {
    check(object(input) && Object.keys(input).every(k => fields.includes(k)), 'INVALID_RULE', 400);
    const rule = { enabled: true, taskIds: [], eventTypes: ['baseline','created','changed'], keywords: [], pushEnabled: false, ...previous, ...input };
    check(typeof rule.name === 'string' && rule.name.trim().length > 0 && rule.name.length <= 200 && typeof rule.enabled === 'boolean' && typeof rule.pushEnabled === 'boolean', 'INVALID_RULE', 400);
    for (const k of ['taskIds','eventTypes','keywords']) check(Array.isArray(rule[k]) && rule[k].length <= 100 && rule[k].every(x => typeof x === 'string' && x.trim().length > 0 && x.length <= 200), 'INVALID_RULE', 400);
    check(rule.eventTypes.length > 0 && rule.eventTypes.every(x => ['baseline','created','changed'].includes(x)), 'INVALID_RULE', 400);
    for (const id of rule.taskIds) this.store.getTask(id);
    for (const k of ['taskIds','eventTypes','keywords']) rule[k] = [...new Set(rule[k].map(x => x.trim()))];
    rule.name = rule.name.trim(); return rule;
  }
  createRule(input) {
    const rule = this.ruleInput(input); rule.id = randomUUID(); rule.createdAt = rule.updatedAt = this.store.iso();
    this.store.tx(() => this.db.prepare('INSERT INTO notification_rules VALUES(?,?)').run(rule.id, json(rule)));
    return rule;
  }
  patchRule(id, input) {
    const result = this.store.tx(() => {
      const rule = this.ruleInput(input, this.rule(id)); rule.updatedAt = this.store.iso();
      this.db.prepare('UPDATE notification_rules SET doc=? WHERE id=?').run(json(rule), id); this.prunePending(); return rule;
    }); this.wake(); return result;
  }
  deleteRule(id) {
    this.store.tx(() => { this.rule(id); this.db.prepare('DELETE FROM notification_rules WHERE id=?').run(id); this.prunePending(); }); this.wake();
  }
  matches(rule, run, kind, text) {
    return rule.enabled && (!rule.taskIds.length || rule.taskIds.includes(run.taskId)) && rule.eventTypes.includes(kind) && (!rule.keywords.length || rule.keywords.some(k => text.includes(k.toLowerCase())));
  }
  // 仅submit调用，调用方已持有与versions/receipt相同的事务。只接收本次真正新建的事件。
  recordSubmission(run, payload, events, hadBaseline) {
    const rules = this.rules().items;
    if (!hadBaseline) {
      if (payload.completeness !== 'complete') return;
      const text = payload.items.map(item => this.matchText(item, payload)).join('\n').slice(0, 2_000_000);
      const matched = rules.filter(r => this.matches(r, run, 'baseline', text));
      this.insert({ kind: 'baseline', title: '首次完整采集已建立基线', body: `本次完整采集包含 ${payload.items.length} 个项目。`, run, dedupeKey: `baseline:${run.taskId}:${payload.scopeKey}` }, matched);
      return;
    }
    for (const { event, version, item } of events) {
      const matched = rules.filter(r => this.matches(r, run, event.kind, this.matchText(item, payload)));
      this.insert({ kind: event.kind, title: event.kind === 'created' ? '发现新项目' : '项目内容已变化', body: item.sourceKey.slice(0, 200), run, entityId: version.entityId, versionId: version.id, dedupeKey: `version:${version.id}` }, matched);
    }
  }
  matchText(item, payload) {
    const entry = payload.snapshot?.entries?.find(e => e.key === item.sourceKey);
    return [item.sourceKey, entry?.description ?? '', (item.readme?.text ?? '').slice(0, 1_000_000)].join('\n').toLowerCase();
  }
  insert({ kind, title, body, run = null, entityId = null, versionId = null, dedupeKey }, matched, testDeviceId = null) {
    if (!testDeviceId && !matched.length) return null;
    const notification = { id: randomUUID(), kind, title, body, taskId: run?.taskId ?? null, runId: run?.id ?? null, entityId, versionId,
      targetPath: run ? `/runs?runId=${encodeURIComponent(run.id)}${versionId ? `&entityId=${encodeURIComponent(entityId)}&versionId=${encodeURIComponent(versionId)}` : ''}` : '/notifications',
      createdAt: this.store.iso(), readAt: null, dedupeKey, matchedRuleIds: matched.map(r => r.id) };
    const result = this.db.prepare('INSERT OR IGNORE INTO notifications(id,dedupe_key,doc) VALUES(?,?,?)').run(notification.id, dedupeKey, json(notification));
    if (!result.changes) return parse(this.db.prepare('SELECT doc FROM notifications WHERE dedupe_key=?').get(dedupeKey));
    const pushRules = matched.filter(r => r.pushEnabled).map(r => r.id);
    this.db.prepare('INSERT INTO notification_outbox VALUES(?,?,?)').run(notification.id, json(pushRules), kind);
    if (this.config.enabled && this.config.configured && (testDeviceId || pushRules.length)) {
      for (const row of this.db.prepare('SELECT id,doc,secret FROM push_subscriptions WHERE secret IS NOT NULL').all()) {
        if (testDeviceId && row.id !== testDeviceId) continue;
        const device = parse(row);
        const subscriptionData = JSON.parse(row.secret);
        if (device.enabled && (subscriptionData.expirationTime === null || subscriptionData.expirationTime > this.store.now())) this.db.prepare("INSERT INTO push_deliveries(notification_id,subscription_id,status,due_at,updated_at) VALUES(?,?,'pending',?,?)").run(notification.id, row.id, this.store.now(), this.store.iso());
      }
    }
    return notification;
  }
  deliverySummary(id) {
    const result = { pending: 0, retry: 0, sending: 0, accepted: 0, failed: 0, skipped: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS n FROM push_deliveries WHERE notification_id=? GROUP BY status').all(id)) result[row.status] = row.n;
    return result;
  }
  view(notification) { return { ...notification, delivery: this.deliverySummary(notification.id) }; }
  notification(id) { const row = parse(this.db.prepare('SELECT doc FROM notifications WHERE id=?').get(id)); check(row, 'NOTIFICATION_NOT_FOUND', 404); return row; }
  list({ limit = 50, cursor, unread } = {}) {
    check(Number.isInteger(limit) && limit > 0 && limit <= 200, 'INVALID_LIMIT', 400);
    check(unread === undefined || unread === null || ['true','false'].includes(unread), 'INVALID_UNREAD', 400);
    let before = Number.MAX_SAFE_INTEGER;
    if (cursor) {
      try { const c = JSON.parse(Buffer.from(cursor, 'base64url').toString()); check(c.resource === 'notifications' && c.unread === (unread ?? null) && Number.isSafeInteger(c.seq) && c.seq > 0, 'INVALID_CURSOR', 400); before = c.seq; }
      catch { check(false, 'INVALID_CURSOR', 400); }
    }
    const filter = unread === 'true' ? " AND json_extract(doc,'$.readAt') IS NULL" : unread === 'false' ? " AND json_extract(doc,'$.readAt') IS NOT NULL" : '';
    const rows = this.db.prepare(`SELECT seq,doc FROM notifications WHERE seq<?${filter} ORDER BY seq DESC LIMIT ?`).all(before, limit + 1);
    return { items: rows.slice(0, limit).map(row => this.view(parse(row))), nextCursor: rows.length > limit ? Buffer.from(json({ resource: 'notifications', seq: rows[limit - 1].seq, unread: unread ?? null })).toString('base64url') : null };
  }
  unreadCount() { return { count: this.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE json_extract(doc,'$.readAt') IS NULL").get().n }; }
  read(id, input) {
    check(object(input) && Object.keys(input).length === 1 && input.read === true, 'INVALID_READ', 400);
    return this.store.tx(() => { const n = this.notification(id); n.readAt ??= this.store.iso(); this.db.prepare('UPDATE notifications SET doc=? WHERE id=?').run(json(n), id); return this.view(n); });
  }
  readAll() {
    return this.store.tx(() => ({ count: this.db.prepare("UPDATE notifications SET doc=json_set(doc,'$.readAt',?) WHERE json_extract(doc,'$.readAt') IS NULL").run(this.store.iso()).changes }));
  }
  deviceView(row, owner) { return { ...parse(row), owned: row.owner === digest(owner) }; }
  devices(owner) { return { items: this.db.prepare('SELECT id,owner,doc FROM push_subscriptions WHERE secret IS NOT NULL ORDER BY rowid').all().map(row => this.deviceView(row, owner)), nextCursor: null }; }
  registerDevice(input, owner) {
    check(object(input) && Object.keys(input).every(k => ['subscription','deviceLabel'].includes(k)), 'INVALID_SUBSCRIPTION', 400);
    const subscriptionData = subscriptionInput(input.subscription);
    check(subscriptionData.expirationTime === null || subscriptionData.expirationTime > this.store.now(), 'SUBSCRIPTION_EXPIRED', 400);
    const label = input.deviceLabel ?? '';
    check(typeof label === 'string' && label.length <= 100 && !/[\x00-\x1f\x7f]/.test(label), 'INVALID_DEVICE_LABEL', 400);
    const result = this.store.tx(() => {
      const old = this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint_hash=?').get(digest(subscriptionData.endpoint));
      // 已登录的同一浏览器可以携带原密钥续绑新session；不能仅凭endpoint接管其他设备。
      if (old?.secret) check(json(JSON.parse(old.secret).keys) === json(subscriptionData.keys), 'SUBSCRIPTION_CONFLICT', 409);
      const device = { id: old?.id ?? randomUUID(), deviceLabel: label, enabled: true, createdAt: old ? parse(old).createdAt : this.store.iso(), updatedAt: this.store.iso() };
      this.db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET owner=excluded.owner,secret=excluded.secret,doc=excluded.doc').run(device.id, digest(subscriptionData.endpoint), digest(owner), json(subscriptionData), json(device));
      return { ...device, owned: true };
    }); this.wake(); return result;
  }
  removeDevice(id, owner) {
    key(id);
    this.store.tx(() => {
      const row = this.db.prepare('SELECT * FROM push_subscriptions WHERE id=?').get(id);
      check(row, 'SUBSCRIPTION_NOT_FOUND', 404); check(row.owner === digest(owner), 'SUBSCRIPTION_NOT_OWNED', 403);
      this.invalidateDevice(id);
    }); this.wake();
  }
  invalidateDevice(id) {
    const row = this.db.prepare('SELECT doc FROM push_subscriptions WHERE id=?').get(id); if (!row) return;
    const device = parse(row); device.enabled = false; device.updatedAt = this.store.iso();
    this.db.prepare('UPDATE push_subscriptions SET secret=NULL,doc=? WHERE id=?').run(json(device), id);
    this.db.prepare(`UPDATE push_deliveries SET status='skipped',last_code='SUBSCRIPTION_REMOVED',lease_until=NULL,lease_token=NULL,updated_at=? WHERE subscription_id=? AND ${active}`).run(this.store.iso(), id);
  }
  pushAllowed(row) {
    if (!this.config.enabled || !this.config.configured) return false;
    const device = this.db.prepare('SELECT secret,doc FROM push_subscriptions WHERE id=?').get(row.subscription_id);
    if (!device?.secret || !parse(device).enabled) return false;
    const subscriptionData = JSON.parse(device.secret);
    if (subscriptionData.expirationTime !== null && subscriptionData.expirationTime <= this.store.now()) return false;
    const outbox = this.db.prepare('SELECT * FROM notification_outbox WHERE notification_id=?').get(row.notification_id);
    if (outbox.kind === 'test') return true;
    return JSON.parse(outbox.rule_ids).some(id => { const r = parse(this.db.prepare('SELECT doc FROM notification_rules WHERE id=?').get(id)); return r?.enabled && r.pushEnabled; });
  }
  prunePending() {
    for (const row of this.db.prepare(`SELECT * FROM push_deliveries WHERE ${active}`).all()) if (!this.pushAllowed(row)) {
      const code = !this.config.enabled ? 'PUSH_DISABLED' : !this.config.configured ? 'PUSH_NOT_CONFIGURED' : 'PUSH_AUTHORIZATION_REMOVED';
      this.db.prepare("UPDATE push_deliveries SET status='skipped',last_code=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE notification_id=? AND subscription_id=?").run(code, this.store.iso(), row.notification_id, row.subscription_id);
    }
  }
  testPush(requestKey, input, owner) {
    key(requestKey, 'INVALID_IDEMPOTENCY_KEY');
    check(object(input) && Object.keys(input).length === 1 && typeof input.subscriptionId === 'string', 'INVALID_TEST_PUSH', 400);
    key(input.subscriptionId);
    const result = this.store.tx(() => {
      const old = this.db.prepare('SELECT notification_id,subscription_id FROM push_test_requests WHERE request_key=?').get(requestKey);
      if (old) check(old.subscription_id === input.subscriptionId, 'IDEMPOTENCY_CONFLICT');
      const device = this.db.prepare('SELECT * FROM push_subscriptions WHERE id=?').get(input.subscriptionId);
      check(device, 'SUBSCRIPTION_NOT_FOUND', 404); check(device.owner === digest(owner), 'SUBSCRIPTION_NOT_OWNED', 403);
      if (old) return this.view(this.notification(old.notification_id));
      check(this.config.enabled && this.config.configured, this.config.enabled ? 'PUSH_NOT_CONFIGURED' : 'PUSH_DISABLED', 409);
      check(device.secret && parse(device).enabled, 'PUSH_NO_DEVICES', 409);
      const subscriptionData = JSON.parse(device.secret); check(subscriptionData.expirationTime === null || subscriptionData.expirationTime > this.store.now(), 'SUBSCRIPTION_EXPIRED', 409);
      const n = this.insert({ kind: 'test', title: '推送测试', body: '这是一条测试通知，不代表采集变化或设备已展示。', dedupeKey: `test:${requestKey}` }, [], input.subscriptionId);
      this.db.prepare('INSERT INTO push_test_requests(request_key,notification_id,subscription_id) VALUES(?,?,?)').run(requestKey, n.id, input.subscriptionId); return this.view(n);
    }); this.wake(); return result;
  }
  configView() { return { configured: !!this.config.configured, publicKey: this.config.configured ? this.config.publicKey : null, enabled: !!this.config.enabled, reason: this.config.reason ?? null }; }
  counts() {
    const counts = { pending: 0, retry: 0, sending: 0, accepted: 0, failed: 0, skipped: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS n FROM push_deliveries GROUP BY status').all()) counts[row.status] = row.n;
    return counts;
  }
  // 一次短事务取得一条持久lease，网络不在此事务内。重启后未到期lease不抢占。
  claimDelivery(leaseMs) {
    return this.store.tx(() => {
      const now = this.store.now(); this.prunePending();
      this.db.prepare("UPDATE push_deliveries SET status='failed',last_code='PUSH_ATTEMPTS_EXHAUSTED',lease_until=NULL,lease_token=NULL,updated_at=? WHERE status='sending' AND lease_until<=? AND attempts>=5").run(this.store.iso(), now);
      const row = this.db.prepare("SELECT * FROM push_deliveries WHERE attempts<5 AND ((status IN ('pending','retry') AND due_at<=?) OR (status='sending' AND lease_until<=?)) ORDER BY due_at,notification_id,subscription_id LIMIT 1").get(now, now);
      if (!row) return null;
      row.attempts++; row.lease_token = randomUUID(); row.lease_until = now + leaseMs;
      this.db.prepare("UPDATE push_deliveries SET status='sending',attempts=?,lease_until=?,lease_token=?,updated_at=? WHERE notification_id=? AND subscription_id=?").run(row.attempts, row.lease_until, row.lease_token, this.store.iso(), row.notification_id, row.subscription_id);
      return { ...row, subscription: JSON.parse(this.db.prepare('SELECT secret FROM push_subscriptions WHERE id=?').get(row.subscription_id).secret), notification: this.notification(row.notification_id) };
    });
  }
  finishDelivery(row, { status, code, delay = 0, remove = false }) {
    this.store.tx(() => {
      const current = this.db.prepare("SELECT status,lease_token FROM push_deliveries WHERE notification_id=? AND subscription_id=?").get(row.notification_id, row.subscription_id);
      if (current?.status !== 'sending' || current.lease_token !== row.lease_token) return;
      this.db.prepare('UPDATE push_deliveries SET status=?,due_at=?,lease_until=NULL,lease_token=NULL,last_code=?,updated_at=? WHERE notification_id=? AND subscription_id=?').run(status, this.store.now() + delay, code, this.store.iso(), row.notification_id, row.subscription_id);
      if (remove) this.invalidateDevice(row.subscription_id);
    });
  }
  nextDeliveryAt() {
    return this.db.prepare("SELECT MIN(CASE WHEN status='sending' THEN lease_until ELSE due_at END) AS due FROM push_deliveries WHERE status IN ('pending','retry','sending')").get().due;
  }
}
