import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Admission, controlServer } from '../src/lifecycle.js';
import { requestWorker } from '../src/cli.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { host: '127.0.0.1', port: server.address().port };
}

for (const value of ['中文选择器', '😀页面文本']) {
  test(`控制请求保留跨块 UTF-8：${value}`, { timeout: 5000 }, async () => {
    const admission = new Admission();
    let received;
    const server = controlServer(admission, async request => { received = request.selector; return received; });
    const address = await listen(server);
    const socket = createConnection(address);
    socket.on('error', () => {});
    try {
      await once(socket, 'connect');
      const payload = Buffer.from(JSON.stringify({ command: 'read', selector: value }) + '\n');
      const offset = payload.indexOf(Buffer.from(value)) + 1;
      const response = once(socket, 'data');
      socket.write(payload.subarray(0, offset));
      await delay(25);
      socket.write(payload.subarray(offset));
      await response;
      assert.equal(received, value);
    } finally { socket.destroy(); admission.close(); await admission.drain(); }
  });

  test(`CLI 响应保留跨块 UTF-8：${value}`, { timeout: 5000 }, async () => {
    const sockets = new Set();
    const server = createServer(socket => {
      sockets.add(socket); socket.on('error', () => {});
      socket.once('data', () => {
        const payload = Buffer.from(JSON.stringify({ ok: true, result: { text: value } }) + '\n');
        const offset = payload.indexOf(Buffer.from(value)) + 1;
        socket.write(payload.subarray(0, offset));
        setTimeout(() => { if (!socket.destroyed) socket.end(payload.subarray(offset)); }, 25);
      });
    });
    const address = await listen(server);
    try {
      assert.deepEqual(await requestWorker({ command: 'read', selector: 'h1' }, address, 2000), { text: value });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
