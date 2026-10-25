// 仅在独立开发 worker 内显式运行；不访问账号，不属于无 Chrome 单元测试。
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Cdp, CdpPage } from '../src/cdp.js';
import { requestWorker } from '../src/cli.js';

const mode = process.argv[2];
setTimeout(() => { console.error('CONTAINER_INTEGRATION_TIMEOUT'); process.exit(1); }, 60000).unref();
const fixture = 'http://127.0.0.1:8080/';
const probe = { url: fixture, validSelector: '[data-session="valid"]', loginSelector: '#login-required', challengeSelector: '#challenge-required' };
const call = (command, extra = {}) => requestWorker({ command, ...extra });
const report = (name, evidence) => console.log(JSON.stringify({ check: name, evidence }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// HTTP Upgrade + 二进制 WebSocket + RFB 3.8，后端必须是真实 websockify/x11vnc。
async function tunnel(origins = ['http://127.0.0.1:6080']) {
  const socket = createConnection({ host: '127.0.0.1', port: 6080 });
  let input = Buffer.alloc(0); let ended = false; let failure;
  socket.on('data', data => { input = Buffer.concat([input, data]); });
  socket.on('close', () => { ended = true; });
  socket.on('error', error => { failure = error; });
  async function until(predicate) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (failure) throw failure;
      if (ended) throw new Error('TUNNEL_CLOSED');
      if (Date.now() > deadline) throw new Error('TUNNEL_TIMEOUT');
      await sleep(10);
    }
  }
  await until(() => socket.readyState === 'open');
  socket.write(['GET /websockify HTTP/1.1', 'Host: 127.0.0.1:6080', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Protocol: binary',
    ...origins.map(origin => `Origin: ${origin}`), '', ''].join('\r\n'));
  await until(() => input.includes('\r\n\r\n'));
  const boundary = input.indexOf('\r\n\r\n');
  const status = Number(input.subarray(0, boundary).toString().split(' ')[1]);
  input = input.subarray(boundary + 4);
  let rfb = Buffer.alloc(0);
  async function read(size) {
    while (rfb.length < size) {
      await until(() => input.length >= 2);
      let length = input[1] & 127; let header = 2;
      if (length === 126) { await until(() => input.length >= 4); length = input.readUInt16BE(2); header = 4; }
      if (length === 127) { await until(() => input.length >= 10); length = Number(input.readBigUInt64BE(2)); header = 10; }
      assert.ok(length < 32 * 1024 * 1024, 'bounded RFB frame');
      await until(() => input.length >= header + length);
      const opcode = input[0] & 15;
      assert.ok(opcode === 2 || opcode === 0, 'binary RFB frame');
      rfb = Buffer.concat([rfb, input.subarray(header, header + length)]);
      input = input.subarray(header + length);
    }
    const result = rfb.subarray(0, size); rfb = rfb.subarray(size); return result;
  }
  function send(data) {
    assert.ok(data.length < 126);
    const mask = randomBytes(4);
    const payload = Buffer.from(data.map((value, i) => value ^ mask[i % 4]));
    socket.write(Buffer.concat([Buffer.from([0x82, 0x80 | data.length]), mask, payload]));
  }
  async function handshake() {
    assert.equal((await read(12)).toString(), 'RFB 003.008\n');
    send(Buffer.from('RFB 003.008\n'));
    const count = (await read(1))[0]; assert.ok(count > 0);
    assert.ok((await read(count)).includes(1), 'localhost no-auth VNC'); send(Buffer.from([1]));
    assert.equal((await read(4)).readUInt32BE(), 0); send(Buffer.from([1]));
    const init = await read(24); const nameSize = init.readUInt32BE(20);
    assert.ok(nameSize < 4096); await read(nameSize);
    return { width: init.readUInt16BE(0), height: init.readUInt16BE(2) };
  }
  return { status, socket, handshake, send, closed: () => ended, until };
}

async function withPage(fn) {
  const cdp = await Cdp.connect(); const page = await CdpPage.create(cdp);
  try { return await fn(page, cdp); } finally { await page.close(); cdp.close(); }
}

if (mode === 'core') {
  assert.deepEqual(await call('health'), { healthy: true });
  assert.deepEqual(await call('connect'), { connected: true });
  assert.deepEqual(await call('navigate'), { navigated: true });
  const text = await call('read', { selector: 'h1' }); assert.ok(text.text);
  const shot = await call('screenshot');
  const png = await readFile(`/data/artifacts/${shot.artifact}`);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const config = JSON.parse(await readFile(new URL('./fixtures/probe.example.json', import.meta.url)));
  assert.equal((await call('probe', { probe: config })).status, 'valid');
  report('fixture-cli', { text: text.text, pngBytes: png.length, probe: 'valid (synthetic DOM only)' });
} else if (mode === 'sandbox') {
  await withPage(async (page, cdp) => {
    await page.send('Page.navigate', { url: 'chrome://sandbox' });
    let text;
    for (let i = 0; i < 50; i++) {
      text = await page.evaluateRead('document.body.innerText');
      if (text.includes('Seccomp')) break;
      await sleep(100);
    }
    report('versions', await cdp.send('Browser.getVersion'));
    report('chrome-sandbox-page', text);
    assert.match(text, /adequately sandboxed/i);
    assert.match(text, /Layer 1 Sandbox\s+Namespace/i);
    assert.match(text, /PID namespaces\s+Yes/i);
    assert.match(text, /Network namespaces\s+Yes/i);
    assert.match(text, /Seccomp-BPF sandbox\s+Yes/i);
    assert.match(text, /Seccomp-BPF sandbox supports TSYNC\s+Yes/i);
  });
} else if (mode === 'persist-write' || mode === 'persist-read') {
  await withPage(async page => {
    await page.navigate(fixture);
    // 每次生成无凭据合成标记；分别验证 localStorage 与有到期时间的持久 Cookie。
    const key = 'page-gather-p1-synthetic';
    const record = '/data/spool/p1-synthetic-storage.json';
    const value = mode === 'persist-write' ? `fixture-${randomUUID()}` : JSON.parse(await readFile(record, 'utf8')).value;
    if (mode === 'persist-write') {
      await page.evaluateRead(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
      const cookie = await page.send('Network.setCookie', { name: key, value, url: fixture, httpOnly: true, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 86400 });
      assert.equal(cookie.success, true);
      await writeFile(record, JSON.stringify({ value }), { mode: 0o600 });
    }
    assert.equal(await page.evaluateRead(`localStorage.getItem(${JSON.stringify(key)})`), value);
    const { cookies } = await page.send('Network.getCookies', { urls: [fixture] });
    const cookie = cookies.find(item => item.name === key);
    assert.equal(cookie?.value, value);
    assert.equal(cookie.session, false);
    assert.equal(cookie.httpOnly, true);
    report(mode, { localStorage: 'synthetic marker matches', persistentCookie: 'synthetic marker matches (HttpOnly)' });
  });
  if (mode === 'persist-read') {
    const state = await call('status'); assert.equal(state.mode, 'PAUSED'); assert.equal(state.session.status, 'unknown');
    report('restart-state', state);
  }
} else if (mode === 'manual') {
  // 可信内部验收使用 CDP 准备合成输入框；产品自动命令仍经唯一控制器。
  await withPage(async page => {
    await page.navigate(fixture);
    await page.evaluateRead('document.body.innerHTML = \'<input id="rfb-test" autofocus>\'; document.querySelector("input").focus()');
    await page.send('Page.bringToFront');
    assert.equal((await call('manual-start')).mode, 'MANUAL');
    const assets = await fetch('http://127.0.0.1:6080/vnc.html');
    assert.equal(assets.status, 200); assert.match(await assets.text(), /noVNC/);
    for (const command of ['connect', 'navigate', 'read', 'screenshot', 'probe']) {
      await assert.rejects(call(command, { selector: 'h1', ...(command === 'probe' ? { probe } : {}) }), /MANUAL_ACTIVE/);
    }
    for (const origins of [[], ['null'], ['https://evil.invalid'], ['http://localhost:6080'], ['http://127.0.0.1:6080', 'http://127.0.0.1:6080']]) {
      const denied = await tunnel(origins); assert.equal(denied.status, 403); denied.socket.destroy();
    }
    const disconnected = await tunnel(); assert.equal(disconnected.status, 101); await disconnected.handshake(); disconnected.socket.destroy();
    assert.equal((await call('status')).mode, 'MANUAL');
    const active = await tunnel(); assert.equal(active.status, 101); const screen = await active.handshake();
    await sleep(250);
    // RFB KeyEvent: type=4, down flag, padding, X11 keysym。
    active.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 97])); active.send(Buffer.from([4, 0, 0, 0, 0, 0, 0, 97]));
    let value;
    for (let i = 0; i < 50; i++) { value = await page.evaluateRead('document.querySelector("input").value'); if (value === 'a') break; await sleep(100); }
    assert.equal(value, 'a', '真实 VNC 键盘输入到 Chrome');
    assert.equal((await call('manual-finish')).mode, 'PAUSED');
    await active.until(active.closed);
    assert.equal(await page.evaluateRead('document.querySelector("input").value'), 'a');
    await assert.rejects(tunnel(), /ECONNREFUSED/);
    report('manual-rfb', { screen, originDenied: 5, input: 'a', disconnectedStillManual: true, oldSocketClosed: true, gatewayStopped: true });
  });
} else {
  throw new Error('显式指定 core / sandbox / manual / persist-write / persist-read');
}
