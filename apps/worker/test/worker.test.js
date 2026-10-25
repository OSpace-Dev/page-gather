import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { Controller } from '../src/controller.js';
import { Cdp, CdpPage, classifyProbe, validateProbe, validateUrl } from '../src/cdp.js';
import { parseArgs, requestWorker } from '../src/cli.js';
import { checkDependencies, checkRepository } from '../../../scripts/check-dependencies.js';

const probe = JSON.parse(await readFile(new URL('./fixtures/probe.example.json', import.meta.url)));
function setup(overrides = {}) {
  const calls = [];
  const controller = new Controller({
    desktop: { start: async () => calls.push('start'), stop: async () => calls.push('stop') },
    execute: async request => { calls.push(request.command); return { status: 'valid', checkedAt: 'fixture' }; },
    ...overrides
  });
  return { controller, calls };
}
test('启动状态未知，不读取历史文件判断会话', () => {
  assert.deepEqual(setup().controller.status().session, { status: 'unknown', checkedAt: null });
});
test('人工模式拒绝所有页面操作；断开客户端不会改变模式', async () => {
  const { controller, calls } = setup();
  await controller.run({ command: 'manual-start' });
  for (const command of ['connect', 'navigate', 'read', 'screenshot', 'probe']) {
    await assert.rejects(controller.run({ command, selector: 'h1', probe }), /MANUAL_ACTIVE/);
  }
  assert.equal(controller.status().mode, 'MANUAL'); assert.deepEqual(calls, ['start']);
});
test('结束人工先撤销输入再探测，通过才 AUTO', async () => {
  const { controller, calls } = setup();
  await controller.run({ command: 'manual-start' });
  await controller.run({ command: 'manual-finish', probe });
  assert.deepEqual(calls, ['start', 'stop', 'probe']); assert.equal(controller.mode, 'AUTO');
});
test('无探测配置结束人工只进入 PAUSED/unknown', async () => {
  const { controller, calls } = setup();
  await controller.run({ command: 'manual-start' }); await controller.run({ command: 'manual-finish' });
  assert.equal(controller.mode, 'PAUSED'); assert.equal(controller.session.status, 'unknown');
  assert.deepEqual(calls, ['start', 'stop']);
});
test('自动操作与人工请求竞争时拒绝，不抢占浏览器', async () => {
  let release;
  const { controller } = setup({ execute: () => new Promise(resolve => { release = resolve; }) });
  const pending = controller.run({ command: 'navigate' });
  await assert.rejects(controller.run({ command: 'manual-start' }), /WORKER_BUSY/);
  release({}); await pending; assert.equal(controller.busy, false);
});
test('人工入口启动中不允许探测', async () => {
  let release;
  const { controller } = setup({ desktop: { start: () => new Promise(resolve => { release = resolve; }), stop: async () => {} } });
  const pending = controller.run({ command: 'manual-start' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(controller.run({ command: 'probe', probe }), /WORKER_BUSY/);
  release(); await pending;
});
test('无法撤销人工入口时永久阻止自动操作直到重启', async () => {
  const { controller } = setup({ desktop: { start: async () => {}, stop: async () => { throw new Error('STOP_FAILED'); } } });
  await controller.run({ command: 'manual-start' });
  await assert.rejects(controller.run({ command: 'manual-finish', probe }), /STOP_FAILED/);
  assert.equal(controller.faulted, true);
  await assert.rejects(controller.run({ command: 'connect' }), /WORKER_RESTART_REQUIRED/);
});
test('探测未知、登录过期、验证码均不进入 AUTO', async () => {
  for (const status of ['unknown', 'login_required', 'challenge_required']) {
    const { controller } = setup({ execute: async () => ({ status }) });
    await controller.run({ command: 'probe', probe }); assert.equal(controller.mode, 'PAUSED');
  }
});
test('探测异常清除上次有效状态', async () => {
  const { controller } = setup({ execute: async () => { throw new Error('READ_FAILED'); } });
  controller.session = { status: 'valid' };
  await assert.rejects(controller.run({ command: 'probe', probe }), /READ_FAILED/);
  assert.equal(controller.session.status, 'unknown');
});
test('页面清理失败后不允许人工或自动继续', async () => {
  const { controller } = setup({ execute: async () => { throw new Error('TARGET_CLEANUP_FAILED'); } });
  await assert.rejects(controller.run({ command: 'navigate' }), /TARGET_CLEANUP_FAILED/);
  await assert.rejects(controller.run({ command: 'manual-start' }), /WORKER_RESTART_REQUIRED/);
});
test('状态落盘失败时不开放人工入口', async () => {
  const { controller, calls } = setup({ save: async () => { throw new Error('DISK_FULL'); } });
  await assert.rejects(controller.run({ command: 'manual-start' }), /DISK_FULL/);
  assert.deepEqual(calls, ['stop']); assert.equal(controller.faulted, true);
});
test('URL 校验拒绝脚本、本地文件、内嵌凭据', () => {
  for (const url of ['javascript:void(0)', 'file:///fixture', 'https://name:pass@example.invalid']) assert.throws(() => validateUrl(url));
  assert.equal(validateUrl('about:blank'), 'about:blank');
  assert.equal(validateUrl('https://example.invalid'), 'https://example.invalid/');
});
test('必须显式声明三种探测选择器，存在性不能默认为有效', () => {
  assert.throws(() => validateProbe({ url: probe.url, validSelector: '#a' }));
  assert.throws(() => validateProbe({ ...probe, url: 'about:blank' }));
  assert.equal(classifyProbe({}), 'unknown');
  assert.equal(classifyProbe({ valid: true, login: true }), 'login_required');
  assert.equal(classifyProbe({ valid: true, challenge: true }), 'challenge_required');
});
class FakeSocket extends EventTarget {
  readyState = 1; messages = [];
  send(raw) { this.messages.push(JSON.parse(raw)); }
  message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
test('CDP 按 id 关联乱序响应并传递 sessionId', async () => {
  const socket = new FakeSocket(); const cdp = new Cdp(socket);
  const first = cdp.send('Page.enable', {}, 'session'); const second = cdp.send('Browser.getVersion');
  assert.equal(socket.messages[0].sessionId, 'session');
  socket.message({ id: 2, result: { second: true } }); socket.message({ id: 1, result: { first: true } });
  assert.deepEqual(await first, { first: true }); assert.deepEqual(await second, { second: true }); cdp.close();
});
test('CDP 超时清除 pending', async () => {
  const socket = new FakeSocket(); const cdp = new Cdp(socket, 10);
  await assert.rejects(cdp.send('No.response'), /CDP_COMMAND_TIMEOUT/);
  assert.equal(cdp.pending.size, 0); cdp.close();
});
test('CDP 断连拒绝未完成命令，不重放', async () => {
  const socket = new FakeSocket(); const cdp = new Cdp(socket);
  const pending = cdp.send('Page.enable'); cdp.close();
  await assert.rejects(pending, /CDP_DISCONNECTED/); assert.equal(socket.messages.length, 1);
});
test('CDP 协议错误不泄露原始站点信息', async () => {
  const socket = new FakeSocket(); const cdp = new Cdp(socket); const pending = cdp.send('Page.enable');
  socket.message({ id: 1, error: { message: 'sensitive fixture' } });
  await assert.rejects(pending, /^Error: CDP_COMMAND_FAILED$/); cdp.close();
});
test('只允许容器 loopback CDP discovery', async () => {
  await assert.rejects(Cdp.connect('http://example.invalid:9222'), /CDP_LOOPBACK_ONLY/);
});
class FakeCdp extends EventEmitter {
  calls = [];
  constructor(behavior) { super(); this.behavior = behavior; }
  async send(method, params, sessionId) { this.calls.push({ method, params, sessionId }); return this.behavior(method, params, sessionId, this); }
}
test('创建标签响应丢失必须进入待恢复，不猜测安全状态', async () => {
  const cdp = new FakeCdp(() => { throw new Error('CDP_COMMAND_TIMEOUT'); });
  await assert.rejects(CdpPage.create(cdp), /TARGET_CLEANUP_FAILED/);
});
test('关闭标签必须得到成功确认', async () => {
  const cdp = new FakeCdp(() => ({ success: false }));
  await assert.rejects(new CdpPage(cdp, 't', 's').close(), /TARGET_CLEANUP_FAILED/);
});
test('导航 load 先于响应到达也不丢事件，忽略其他会话', async () => {
  const cdp = new FakeCdp((method, params, sessionId, self) => {
    self.emit('event', { sessionId: 'other', method: 'Page.lifecycleEvent', params: { name: 'load', loaderId: 'other' } });
    self.emit('event', { sessionId, method: 'Page.lifecycleEvent', params: { name: 'load', loaderId: 'loader' } });
    return { loaderId: 'loader' };
  });
  const page = new CdpPage(cdp, 'target', 'session'); await page.navigate('about:blank', 20);
  assert.equal(cdp.listenerCount('event'), 0);
});
test('导航有界超时，监听器回收', async () => {
  const cdp = new FakeCdp(() => ({ loaderId: 'never' }));
  await assert.rejects(new CdpPage(cdp, 't', 's').navigate('about:blank', 10), /NAVIGATION_TIMEOUT/);
  assert.equal(cdp.listenerCount('event'), 0);
});
test('导航网络错误/下载明确失败', async () => {
  for (const result of [{ errorText: 'fixture error' }, { isDownload: true }]) {
    const cdp = new FakeCdp(() => result);
    await assert.rejects(new CdpPage(cdp, 't', 's').navigate(), /NAVIGATION_FAILED/);
  }
});
test('跨源重定向不能仅因选择器匹配而标为已登录', async () => {
  const cdp = new FakeCdp(method => method === 'Runtime.evaluate' ? { result: { value: { sameOrigin: false, valid: true } } } : {});
  const result = await new CdpPage(cdp, 't', 's').probe(probe);
  assert.equal(result.status, 'unknown');
});
test('Runtime 异常明确失败；readText 仅生成受限读取表达式', async () => {
  const cdp = new FakeCdp(() => ({ exceptionDetails: {} }));
  await assert.rejects(new CdpPage(cdp, 't', 's').readText('#fixture'), /READ_FAILED/);
  assert.match(cdp.calls[0].params.expression, /textContent/);
});
test('CLI 不自动启动浏览器，拒绝未知参数与缺省探测配置', async () => {
  assert.deepEqual(await parseArgs(['navigate']), { command: 'navigate' });
  for (const args of [[], ['probe'], ['read'], ['navigate', '--click', 'button'], ['navigate', '--url'], ['connect', '--url', 'about:blank']]) await assert.rejects(parseArgs(args));
});
test('CLI 从明确文件加载探测规则', async () => {
  const request = await parseArgs(['probe', '--config', 'apps/worker/test/fixtures/probe.example.json']);
  assert.deepEqual(request, { command: 'probe', probe });
});
test('禁止依赖检查涵盖清单、间接锁包和额外 manifest', () => {
  checkRepository();
  assert.throws(() => checkDependencies({ dependencies: { forbidden: '1' } }, { lockfileVersion: 3, packages: { '': {} } }));
  assert.throws(() => checkDependencies({}, { lockfileVersion: 3, packages: { '': {}, 'node_modules/indirect': {} } }));
  assert.throws(() => checkDependencies({}, { lockfileVersion: 3, packages: { '': { dependencies: { forbidden: '1' } } } }));
});
async function withServer(handler, execute) {
  const sockets = new Set();
  const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); handler(socket); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await execute({ host: '127.0.0.1', port: server.address().port }); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}
test('CLI 传输真实 socket：分片 JSON 与逐行 framing', async () => {
  await withServer(socket => socket.once('data', chunk => {
    assert.equal(JSON.parse(String(chunk)).command, 'status');
    socket.write('{"ok":true,');
    setImmediate(() => socket.end('"result":42}' + String.fromCharCode(10)));
  }), async address => assert.equal(await requestWorker({ command: 'status' }, address), 42));
});
test('CLI 传输错误与超时有界，不自动重试', async () => {
  await withServer(socket => socket.once('data', () => socket.end(JSON.stringify({ ok: false, code: 'MANUAL_ACTIVE' }) + String.fromCharCode(10))),
    async address => assert.rejects(requestWorker({ command: 'connect' }, address), /MANUAL_ACTIVE/));
  await withServer(() => {}, async address => assert.rejects(requestWorker({ command: 'status' }, address, 20), /WORKER_TIMEOUT/));
});
test('部署静态安全边界：非 root、loopback 发布、无 CDP/VNC 映射', async () => {
  const compose = await readFile('compose.yaml', 'utf8'); const dockerfile = await readFile('infra/browser/Dockerfile', 'utf8');
  const supervisor = await readFile('apps/worker/src/supervisor.js', 'utf8');
  assert.match(compose, /127\.0\.0\.1:6080:6080/);
  assert.doesNotMatch(compose, /["']?\d+:9222|["']?\d+:5900|privileged:\s*true|docker\.sock/);
  assert.match(dockerfile, /USER node/); assert.match(dockerfile, /linux\/amd64/);
  assert.match(supervisor, /--remote-debugging-address=127\.0\.0\.1/);
  assert.doesNotMatch(supervisor, /--no-sandbox|--headless/);
});
