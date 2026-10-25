import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ProcessGroups, Admission, controlServer, quiesce } from '../src/lifecycle.js';
import { createNovncGateway, parseOrigins } from '../src/novnc-gateway.js';
import { Controller } from '../src/controller.js';
import { hasSensitivePattern } from '../../../scripts/check-privacy.js';
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function connect(port) { const socket = createConnection({ host: '127.0.0.1', port }); socket.on('error', () => {}); await once(socket, 'connect'); return socket; }

function fakeGroups(options = {}) {
  let alive = true; let spawns = 0; const signals = []; const child = new EventEmitter(); child.pid = 12345;
  const groups = new ProcessGroups({
    interval: 1, termAttempts: 1, killAttempts: 1,
    spawnProcess: () => { spawns++; return child; },
    kill: (pid, signal) => {
      assert.equal(pid, -child.pid);
      if (!alive) throw Object.assign(new Error(), { code: 'ESRCH' });
      if (signal) signals.push(signal);
      if (signal === 'SIGKILL') alive = false;
    }, ...options
  });
  return { groups, child, signals, spawns: () => spawns, disappear: () => { alive = false; } };
}

test('组长 exit 后仍追踪存活后代，stopAll 强杀并确认组清空', async () => {
  const { groups, child, signals } = fakeGroups();
  groups.launch('fixture', [], false); child.emit('exit', 0);
  assert.equal(child.ended, true); assert.equal(groups.processes.has(child), true);
  groups.seal(); await groups.stopAll();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.equal(groups.processes.size, 0);
});
test('无法确认进程组清空时保留注册项并报错', async () => {
  const { groups, child } = fakeGroups({ kill: () => {} });
  groups.launch('fixture', [], false); child.emit('exit', 0);
  await assert.rejects(groups.stopAll(), /PROCESS_STOP_FAILED/);
  assert.equal(groups.processes.has(child), true);
});
test('无进程的 spawn error 与已清空组 exit 可移除，门禁关闭后不调用 spawn', () => {
  const { groups, child, disappear, spawns } = fakeGroups();
  groups.launch('fixture', [], false); disappear(); child.emit('exit', 0);
  assert.equal(groups.processes.size, 0);
  groups.seal(); assert.throws(() => groups.launch('late', []), /SHUTTING_DOWN/); assert.equal(spawns(), 1);
  const failed = new EventEmitter();
  const errors = new ProcessGroups({ spawnProcess: () => failed });
  errors.launch('missing', [], false); failed.emit('error', new Error('fixture'));
  assert.equal(errors.processes.size, 0);
});
test('POSIX 真实组长退出后仍回收同组后代', { skip: process.platform === 'win32' ? 'Windows 不支持 POSIX 负 PID 进程组；目标 Linux 必须复跑' : false, timeout: 15000 }, async () => {
  const groups = new ProcessGroups({ interval: 20, termAttempts: 10, killAttempts: 200 });
  // 组长收到 IPC 消息后退出；同组子进程忽略 TERM，确保不是只测组长。
  const source = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']}); c.once('message',()=>process.send('ready')); process.on('message',()=>process.exit(0));`;
  const realSpawn = spawn;
  groups.spawnProcess = (command, args, options) => realSpawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const child = groups.launch(process.execPath, ['-e', source], false);
  try {
    await once(child, 'message'); const exited = once(child, 'exit'); child.send('exit'); await exited;
    assert.equal(groups.processes.has(child), true); assert.equal(groups.exists(child), true);
    groups.seal(); await groups.stopAll(); assert.equal(groups.exists(child), false);
  } finally { groups.signal(child, 'SIGKILL'); }
});

for (const failed of [false, true]) test(`停机先封闭门禁并等待正常关闭，关闭${failed ? '失败仍清理并报错' : '成功后回收后代'}`, async () => {
  const { groups, signals } = fakeGroups(); const admission = new Admission();
  groups.launch('fixture', [], false);
  const closing = deferred();
  const pending = quiesce({ groups, admission, beforeStop: async () => {
    assert.equal(admission.closed, true);
    assert.equal(groups.closed, true);
    await closing.promise;
    if (failed) throw new Error('CHROME_CLOSE_TIMEOUT');
  } });
  const checked = failed ? assert.rejects(pending, /SHUTDOWN_FAILED/) : pending;
  await turn();
  assert.deepEqual(signals, []);
  closing.resolve(); await checked;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(groups.processes.size, 0);
});

test('noVNC 白名单只接受显式精确 HTTP(S) origin，不接受通配/路径/null', () => {
  assert.deepEqual([...parseOrigins()], ['http://127.0.0.1:6080']);
  assert.equal(parseOrigins('http://localhost:6080,https://example.invalid').size, 2);
  for (const value of ['', '*', 'null', 'http://example.invalid/', 'http://user:pass@example.invalid', 'file://host', 'http://example.invalid,']) {
    assert.throws(() => parseOrigins(value), /INVALID_NOVNC_ORIGINS/);
  }
});
async function handshake(port, headers = []) {
  const socket = await connect(port);
  const response = new Promise((resolve, reject) => {
    let input = ''; socket.on('data', chunk => { input += chunk; if (input.includes('\r\n\r\n')) resolve(input); });
    socket.on('error', reject); socket.on('close', () => reject(new Error('EARLY_CLOSE')));
  });
  socket.write(['GET /websockify HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: Zml4dHVyZS1rZXktMTIzNA==', ...headers, '', ''].join('\r\n'));
  return { socket, response: await response };
}
test('真实 Upgrade 握手拒绝缺失/null/其他/重复 Origin，允许默认项且撤销既有隧道', { timeout: 10000 }, async () => {
  let upgrades = 0; const upstreamSockets = new Set();
  const backend = createServer((req, res) => res.end('fixture'));
  backend.on('upgrade', (req, socket) => {
    upgrades++; upstreamSockets.add(socket); socket.on('error', () => {}); socket.on('close', () => upstreamSockets.delete(socket));
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', chunk => socket.write(chunk));
  });
  const gateway = createNovncGateway({ targetPort: await listen(backend) });
  await gateway.listen(0, '127.0.0.1'); const port = gateway.server.address().port;
  try {
    for (const headers of [[], ['Origin: null'], ['Origin: http://evil.invalid'], ['Origin: http://localhost:6080'], ['Origin: http://127.0.0.1:6080.evil.invalid'], ['Origin: http://127.0.0.1:6080', 'Origin: http://evil.invalid']]) {
      const { socket, response } = await handshake(port, headers); assert.equal(response.startsWith('HTTP/1.1 403'), true); socket.destroy();
    }
    assert.equal(upgrades, 0);
    const { socket, response } = await handshake(port, ['Origin: http://127.0.0.1:6080']);
    assert.equal(response.startsWith('HTTP/1.1 101'), true); assert.equal(upgrades, 1);
    const echoed = once(socket, 'data'); socket.write(Buffer.from([0x89, 0x80, 0, 0, 0, 0]));
    assert.deepEqual((await echoed)[0], Buffer.from([0x89, 0x80, 0, 0, 0, 0]));
    const closed = once(socket, 'close'); await gateway.close(); await closed;
    await assert.rejects(gateway.listen(0, '127.0.0.1'), /SHUTTING_DOWN/);
  } finally {
    await gateway.close(); for (const socket of upstreamSockets) socket.destroy();
    await new Promise(resolve => backend.close(resolve));
  }
});

test('自定义白名单允许明确来源，网关关闭销毁未完成 Upgrade 半包', { timeout: 5000 }, async () => {
  let upgrades = 0;
  const backend = createServer((req, res) => res.end('fixture'));
  backend.on('upgrade', (req, socket) => { upgrades++; socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'); });
  const gateway = createNovncGateway({ origins: parseOrigins('https://example.invalid'), targetPort: await listen(backend) });
  await gateway.listen(0, '127.0.0.1'); const port = gateway.server.address().port;
  try {
    const denied = await handshake(port, ['Origin: http://127.0.0.1:6080']);
    assert.equal(denied.response.startsWith('HTTP/1.1 403'), true); denied.socket.destroy();
    const allowed = await handshake(port, ['Origin: https://example.invalid']);
    assert.equal(allowed.response.startsWith('HTTP/1.1 101'), true); allowed.socket.destroy();
    assert.equal(upgrades, 1);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/vnc.html`)).text(), 'fixture');
    const partial = await connect(port); const closed = new Promise(resolve => partial.once('close', resolve));
    partial.write('GET /websockify HTTP/1.1\r\n');
    await gateway.close(); await closed; assert.equal(upgrades, 1);
  } finally { await gateway.close(); await new Promise(resolve => backend.close(resolve)); }
});

test('已接收半包在停机后被销毁，不进入控制器', { timeout: 5000 }, async () => {
  const admission = new Admission(); let requests = 0;
  const server = controlServer(admission, () => { requests++; });
  const socket = await connect(await listen(server));
  const gotHalf = once([...admission.sockets][0], 'data'); socket.write('{"command":"manual-start"'); await gotHalf;
  const closed = new Promise(resolve => socket.once('close', resolve));
  const serverClosed = once([...admission.sockets][0], 'close');
  admission.close(); socket.write('}\n'); await closed; await serverClosed; await admission.drain();
  assert.equal(requests, 0); assert.equal(admission.sockets.size, 0);
});
test('排队但尚未执行的请求在关门后被拒绝', async () => {
  const admission = new Admission(); let executed = false;
  const pending = admission.run(() => { executed = true; });
  admission.close(); await assert.rejects(pending, /SHUTTING_DOWN/); await admission.drain();
  assert.equal(executed, false); assert.throws(() => admission.run(() => {}), /SHUTTING_DOWN/);
});
for (const phase of ['persist', 'readiness']) {
  test(`在途 manual-start 在 ${phase} 等待时停机，快照后无新 spawn 并等待清理`, { timeout: 5000 }, async () => {
    const admission = new Admission(); const { groups, spawns } = fakeGroups();
    const entered = deferred(); const release = deferred(); let cleaned = false;
    const desktop = {
      async start() {
        groups.launch('vnc', [], false);
        if (phase === 'readiness') { entered.resolve(); await release.promise; }
        groups.launch('websockify', [], false);
      },
      async stop() { await groups.stopAll(); cleaned = true; }
    };
    const controller = new Controller({ desktop, execute: async () => {}, save: async state => {
      if (phase === 'persist' && state.mode === 'MANUAL_REQUESTED') { entered.resolve(); await release.promise; }
    } });
    const server = controlServer(admission, request => controller.run(request));
    const socket = await connect(await listen(server)); socket.write(JSON.stringify({ command: 'manual-start' }) + '\n');
    await entered.promise;
    let drained = false; const draining = quiesce({ groups, admission }).then(() => { drained = true; });
    assert.equal(groups.closed, true); assert.equal(admission.closed, true);
    await turn(); assert.equal(drained, false); release.resolve(); await draining;
    assert.equal(spawns(), phase === 'persist' ? 0 : 1); assert.equal(groups.processes.size, 0);
    assert.equal(cleaned, true); assert.equal(controller.busy, false);
  });
}

test('隐私扫描合成正例覆盖 JSON/YAML/env 引号键与标点值', () => {
  // 仅运行时拼装合成数据，仓库内不保存可被误认的凭据字面量。
  const value = ['fixture', 'ONLY', '0123456789', '!@=+/.'].join('-');
  for (const key of ['password', 'token', 'secret', 'api_key', 'API_KEY', 'ACCESS_TOKEN', 'client-secret']) {
    for (const line of [JSON.stringify({ [key]: value }), `'${key}': '${value}'`, `${key}: ${value}`, `${key}=${value}`, `export ${key}="${value}"`]) {
      assert.equal(hasSensitivePattern(line), true, `语法未命中: ${key}`);
    }
  }
});
test('隐私扫描合成反例及所有 Windows 盘符路径，避免变量引用误报', () => {
  for (const line of ['token=short', 'notpassword=abcdefghijklmnop', 'token_count: 1234567890123456', 'api_key: <synthetic-placeholder>', 'TOKEN=process.env.SYNTHETIC_TOKEN', '普通说明 password 不包含赋值']) assert.equal(hasSensitivePattern(line), false);
  for (const quote of ['', '"', "'"]) assert.equal(hasSensitivePattern('TOKEN=' + quote + '${SYNTHETIC_TOKEN}' + quote), false);
  for (const drive of ['A', 'D', 'Z', 'z']) {
    for (const separator of ['/', String.fromCharCode(92)]) {
      assert.equal(hasSensitivePattern(drive + ':' + separator + 'synthetic' + separator + 'fixture'), true);
    }
  }
});
