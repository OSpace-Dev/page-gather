import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, createPublicKey, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webPush from 'web-push';
import { loadPushConfiguration, validatePushSubscription, createPushTransport } from '../push-transport.js';

const require = createRequire(import.meta.url);
// 仅测试使用 web-push 自身的传递依赖，不新增生产依赖。
const ece = createRequire(require.resolve('web-push'))('http_ece');

function fixture() {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const keys = webPush.generateVAPIDKeys();
  const config = { enabled: true, configured: true, ...keys, subject: 'mailto:push@example.com', reason: null };
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-test-only', expirationTime: null,
    keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }
  };
  return { receiver, config, subscription };
}

function input(subscription, extra = {}) {
  return { subscription, payload: { title: 'Synthetic transport test' }, notificationId: 'synthetic-notification-1', ...extra };
}

function resolveAgent(agent, hostname = 'fcm.googleapis.com', all = false) {
  return new Promise((resolve, reject) => agent.options.lookup(hostname, { all }, (error, address, family) => error ? reject(error) : resolve(all ? address : { address, family })));
}

function injected(config, handler, lookup = (_host, _options, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }])) {
  return createPushTransport(config, { webPushSend: handler, lookup });
}

test('默认禁用，启用但缺少配置返回固定安全码', () => {
  assert.deepEqual(loadPushConfiguration({}), { enabled: false, configured: false, publicKey: null, privateKey: null, subject: null, reason: 'PUSH_DISABLED' });
  assert.equal(loadPushConfiguration({ PAGE_GATHER_PUSH_ENABLED: 'TRUE' }).enabled, false);
  for (const subject of [undefined, 'javascript:example', 'mailto:not-a-contact', 'https://name:secret@example.com/', 'mailto:a@example.com?secret=x']) {
    const result = loadPushConfiguration({ PAGE_GATHER_PUSH_ENABLED: 'true', PAGE_GATHER_VAPID_SUBJECT: subject });
    assert.equal(result.configured, false);
    assert.equal(result.reason, 'PUSH_INVALID_SUBJECT');
    assert.equal(result.privateKey, null);
  }
});

test('VAPID文件配对、schema、权限、链接和大小边界', { skip: process.platform === 'win32' ? 'Windows不能证明POSIX 0600；需Linux执行该项' : false }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-config-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'vapid.json');
  const { config } = fixture();
  const keys = { publicKey: config.publicKey, privateKey: config.privateKey };
  const env = { PAGE_GATHER_PUSH_ENABLED: 'true', PAGE_GATHER_VAPID_SUBJECT: config.subject, PAGE_GATHER_VAPID_FILE: file };
  const write = (data) => { fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); fs.chmodSync(file, 0o600); };
  assert.equal(loadPushConfiguration(env).reason, 'PUSH_KEY_FILE_MISSING');
  write(keys);
  assert.deepEqual(loadPushConfiguration(env), config);
  assert.equal(loadPushConfiguration({ ...env, PAGE_GATHER_VAPID_SUBJECT: 'https://example.com/contact' }).configured, true);
  for (const bad of [{ ...keys, privateKey: fixture().config.privateKey }, { ...keys, privateKey: 'bad' }, { ...keys, extra: true }, { ...keys, publicKey: randomBytes(65).toString('base64url') }, { ...keys, publicKey: `${keys.publicKey}=` }]) {
    write(bad);
    assert.equal(loadPushConfiguration(env).reason, 'PUSH_INVALID_CONFIGURATION');
  }
  write(keys);
  fs.chmodSync(file, 0o644);
  assert.equal(loadPushConfiguration(env).reason, 'PUSH_UNSAFE_KEY_FILE');
  write(keys);
  const hard = path.join(dir, 'hard');
  fs.linkSync(file, hard);
  assert.equal(loadPushConfiguration(env).reason, 'PUSH_UNSAFE_KEY_FILE');
  fs.unlinkSync(hard);
  const sym = path.join(dir, 'symlink');
  fs.symlinkSync(file, sym);
  assert.equal(loadPushConfiguration({ ...env, PAGE_GATHER_VAPID_FILE: sym }).reason, 'PUSH_UNSAFE_KEY_FILE');
  fs.writeFileSync(file, ' '.repeat(4097));
  assert.equal(loadPushConfiguration(env).reason, 'PUSH_UNSAFE_KEY_FILE');
  assert.equal(loadPushConfiguration({ ...env, PAGE_GATHER_VAPID_FILE: dir }).reason, 'PUSH_UNSAFE_KEY_FILE');
});

test('订阅只接受受支持HTTPS服务、有效曲线点及精确长度密钥', () => {
  const { subscription } = fixture();
  assert.deepEqual(validatePushSubscription({ ...subscription, ignored: true }), subscription);
  for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']) {
    assert.ok(validatePushSubscription({ ...subscription, endpoint: `https://${host}:443/synthetic` }));
  }
  // 纯函数输入边界测试；不产生请求或网络探测。
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:444/x', 'https://user:pass@fcm.googleapis.com/x', 'https://fcm.googleapis.com/x#fragment', 'https://fcm.googleapis.com/x#', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://unknown.example/x', 'https://fcm.googleapis.com.example/x', 'https://push.apple.com/x']) {
    assert.throws(() => validatePushSubscription({ ...subscription, endpoint }), { code: 'PUSH_INVALID_SUBSCRIPTION' });
  }
  for (const keys of [{ ...subscription.keys, auth: randomBytes(15).toString('base64url') }, { ...subscription.keys, p256dh: randomBytes(65).toString('base64url') }, { ...subscription.keys, auth: `${subscription.keys.auth}=` }]) {
    assert.throws(() => validatePushSubscription({ ...subscription, keys }), { code: 'PUSH_INVALID_SUBSCRIPTION' });
  }
  for (const expirationTime of [-1, Infinity, 'tomorrow']) assert.throws(() => validatePushSubscription({ ...subscription, expirationTime }), { code: 'PUSH_INVALID_SUBSCRIPTION' });
});

test('201响应裁剪、固定TTL/timeout/topic及每次调用独立VAPID和agent', async () => {
  const { config, subscription } = fixture();
  const calls = [];
  const send = injected(config, async (sub, payload, options) => {
    calls.push(options);
    assert.deepEqual(sub, subscription);
    assert.equal(JSON.parse(payload).title, 'Synthetic transport test');
    assert.equal(options.timeout, 10000);
    assert.equal(options.TTL, 3600);
    assert.equal(options.contentEncoding, 'aes128gcm');
    assert.deepEqual(options.vapidDetails, { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey });
    return { statusCode: 201, headers: { authorization: 'synthetic-secret', location: subscription.endpoint }, body: 'not returned' };
  });
  assert.deepEqual(await send(input(subscription)), { statusCode: 201, headers: {} });
  await send(input(subscription));
  assert.equal(calls[0].topic.length, 32);
  assert.equal(calls[0].topic, calls[1].topic);
  assert.notEqual(calls[0].agent, calls[1].agent);
  await assert.rejects(resolveAgent(calls[0].agent), { code: 'PUSH_ABORTED' });
});

test('HTTP及库错误仅返回安全码、状态和有界Retry-After', async () => {
  const { config, subscription } = fixture();
  for (const statusCode of [410, 429, 503, 302]) {
    const send = injected(config, async () => { throw { statusCode, headers: { 'retry-after': '99999', authorization: 'synthetic-secret' }, body: 'secret', endpoint: subscription.endpoint }; });
    await assert.rejects(send(input(subscription)), (error) => {
      assert.equal(error.code, 'PUSH_HTTP_ERROR');
      assert.equal(error.statusCode, statusCode);
      assert.equal(error.safeRetryAfter, 3600);
      assert.deepEqual(Object.keys(error).sort(), ['code', 'safeRetryAfter', 'statusCode']);
      assert.equal(error.message, 'PUSH_HTTP_ERROR');
      return true;
    });
  }
  const send = injected(config, async () => { throw new Error(`synthetic error ${subscription.endpoint}`); });
  await assert.rejects(send(input(subscription)), { code: 'PUSH_NETWORK_ERROR', message: 'PUSH_NETWORK_ERROR' });
  const disabled = injected({ enabled: false }, () => assert.fail('disabled must not call library'));
  await assert.rejects(disabled(input(subscription)), { code: 'PUSH_NOT_CONFIGURED' });
});

test('发送时lookup只接受公开IPv4/IPv6，且每次发送重新解析', async () => {
  const { config, subscription } = fixture();
  let count = 0;
  for (const [address, family] of [['8.8.8.8', 4], ['2606:4700:4700::1111', 6], ['2001:4860:4860::8888', 6]]) {
    const send = injected(config, async (_sub, _payload, options) => {
      assert.deepEqual(await resolveAgent(options.agent), { address, family });
      assert.deepEqual(await resolveAgent(options.agent, undefined, true), [{ address, family }]);
      return { statusCode: 201 };
    }, (_host, options, callback) => {
      count++;
      assert.equal(options.all, true);
      callback(null, [{ address, family }]);
    });
    await send(input(subscription));
    await send(input(subscription));
  }
  assert.equal(count, 12);
});

test('合成DNS边界拒绝私网、metadata、mapped、特殊地址和混合记录；无真实网络', async () => {
  const { config, subscription } = fixture();
  const addresses = ['0.0.0.0', '10.1.2.3', '127.0.0.1', '100.100.100.200', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:8.8.8.8', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:808:808::1', '2001::1', 'not-an-ip'];
  for (const address of addresses) {
    const send = injected(config, async (_sub, _payload, options) => {
      await resolveAgent(options.agent);
      return { statusCode: 201 };
    }, (_host, _options, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]));
    await assert.rejects(send(input(subscription)), { code: 'PUSH_DNS_BLOCKED' });
  }
  for (const records of [[], [{ address: '8.8.8.8', family: 6 }]]) {
    const send = injected(config, async (_sub, _payload, options) => {
      await resolveAgent(options.agent);
    }, (_host, _options, callback) => callback(null, records));
    await assert.rejects(send(input(subscription)), { code: records.length ? 'PUSH_DNS_BLOCKED' : 'PUSH_DNS_FAILED' });
  }
});

test('取消在库调用前阻止发送；进行中取消销毁请求，迟到DNS和后续请求均关闭', async () => {
  const { config, subscription } = fixture();
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(injected(config, () => assert.fail('must not send'))(input(subscription, { signal: pre.signal })), { code: 'PUSH_ABORTED' });
  const controller = new AbortController();
  let capturedAgent;
  let dnsCallback;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const request = new EventEmitter();
  request.getHeader = () => 'fcm.googleapis.com';
  let destroyed = 0;
  request.destroy = () => { destroyed++; request.emit('close'); };
  const send = injected(config, (_sub, _payload, options) => {
    capturedAgent = options.agent;
    // 独立合成请求加入agent跟踪，不创建真实socket。
    options.agent.createSocket = () => {};
    options.agent.addRequest(request, { host: 'fcm.googleapis.com', port: 443 });
    const pending = resolveAgent(options.agent);
    started();
    return pending;
  }, (_host, _options, callback) => { dnsCallback = callback; });
  const pending = send(input(subscription, { signal: controller.signal }));
  await ready;
  controller.abort();
  await assert.rejects(pending, { code: 'PUSH_ABORTED' });
  assert.equal(destroyed, 1);
  dnsCallback(null, [{ address: '8.8.8.8', family: 4 }]);
  const late = { destroy(error) { assert.equal(error.code, 'PUSH_ABORTED'); destroyed++; } };
  capturedAgent.addRequest(late, {});
  assert.equal(destroyed, 2);
});

test('绝对10秒超时关闭传输，不依赖socket inactivity timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { config, subscription } = fixture();
  let agent;
  const send = injected(config, (_sub, _payload, options) => { agent = options.agent; return new Promise(() => {}); });
  const pending = send(input(subscription));
  await Promise.resolve();
  const rejected = assert.rejects(pending, { code: 'PUSH_TIMEOUT' });
  t.mock.timers.tick(10000);
  await rejected;
  await assert.rejects(resolveAgent(agent), { code: 'PUSH_TIMEOUT' });
});

test('真实web-push构造RFC加密payload，合成接收密钥可解密且VAPID为ES256', () => {
  const { config, subscription, receiver } = fixture();
  const payload = JSON.stringify({ title: 'Clearly labeled synthetic encryption test' });
  const request = webPush.generateRequestDetails(subscription, payload, {
    TTL: 3600, contentEncoding: 'aes128gcm',
    vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey }
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.endpoint, subscription.endpoint);
  assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(Buffer.isBuffer(request.body));
  assert.notEqual(request.body.toString(), payload);
  assert.equal(ece.decrypt(request.body, { version: 'aes128gcm', privateKey: receiver, authSecret: subscription.keys.auth }).toString(), payload);
  const authorization = request.headers.Authorization;
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  assert.ok(match);
  assert.equal(match[2], config.publicKey);
  const [header, claims, signature] = match[1].split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256');
  const jwt = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(jwt.aud, new URL(subscription.endpoint).origin);
  assert.equal(jwt.sub, config.subject);
  const pub = Buffer.from(config.publicKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});
