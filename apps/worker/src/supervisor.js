import { ProcessGroups, Admission, controlServer, quiesce } from './lifecycle.js';
import { createNovncGateway, parseOrigins } from './novnc-gateway.js';
import { createServer as httpServer } from 'node:http';
import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Cdp, CdpPage } from './cdp.js';
import { Controller } from './controller.js';

process.umask(0o077);
const socketPath = process.env.PAGE_GATHER_SOCKET || '/run/page-gather/control.sock';
const admission = new Admission();
const groups = new ProcessGroups({ onFailure: () => void shutdown(1) });
const origins = parseOrigins(process.env.PAGE_GATHER_NOVNC_ORIGINS);
let shuttingDown = false; let server; let fixture; let controller; let chrome;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const launch = (...args) => groups.launch(...args);
const stop = child => groups.stop(child);
async function waitFor(check, children = [], attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    if (shuttingDown || children.some(child => child.ended)) throw new Error('PROCESS_START_FAILED');
    if (await check()) return;
    await delay(100);
  }
  throw new Error('PROCESS_READY_TIMEOUT');
}
async function tcpReady(port) {
  const { createConnection } = await import('node:net');
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(200, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  });
}
const desktop = {
  children: [], gateway: null,
  async start() {
    admission.assertOpen();
    if (this.children.length) throw new Error('DESKTOP_ALREADY_RUNNING');
    this.children.push(launch('x11vnc', ['-display', ':99', '-localhost', '-rfbport', '5900', '-forever', '-shared', '-nopw', '-quiet']));
    await waitFor(() => tcpReady(5900), this.children);
    this.children.push(launch('websockify', ['--web=/usr/share/novnc', '127.0.0.1:6081', '127.0.0.1:5900']));
    await waitFor(() => tcpReady(6081), this.children);
    admission.assertOpen();
    this.gateway = createNovncGateway({ origins, isOpen: () => !admission.closed });
    await this.gateway.listen();
  },
  async stop() {
    // 先撤销网关（含既有客户端），再关闭 websockify 和原始 VNC。
    await this.gateway?.close(); this.gateway = null;
    for (const child of [...this.children].reverse()) await stop(child);
    this.children = [];
  }
};
async function execute(request) {
  const cdp = await Cdp.connect(); let page;
  try {
    if (request.command === 'connect') { await cdp.send('Browser.getVersion'); return { connected: true }; }
    page = await CdpPage.create(cdp);
    if (request.command === 'probe') return await page.probe(request.probe);
    await page.navigate(request.url || 'http://127.0.0.1:8080/');
    if (request.command === 'read') return { text: await page.readText(request.selector) };
    if (request.command === 'screenshot') {
      const { randomUUID } = await import('node:crypto');
      const name = `${randomUUID()}.png`;
      await writeFile(`/data/artifacts/${name}`, await page.screenshot(), { flag: 'wx', mode: 0o600 });
      return { artifact: name };
    }
    return { navigated: true };
  } finally {
    try { if (page) await page.close(); } catch { throw new Error('TARGET_CLEANUP_FAILED'); }
    finally { cdp.close(); }
  }
}
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  let failed = false;
  try {
    await quiesce({ groups, admission, close: async () => {
      fixture?.close(); fixture?.closeAllConnections();
      await desktop.gateway?.close();
    }, beforeStop: async () => {
      if (code !== 0 || !chrome || chrome.ended) return;
      // SIGTERM 整组会打断 Cookie 数据库写入；先请求 Chrome 正常退出。
      const cdp = await Cdp.connect('http://127.0.0.1:9222', 1000);
      try { await cdp.send('Browser.close'); } finally { cdp.close(); }
      for (let i = 0; i < 30 && !chrome.ended; i++) await delay(100);
      if (!chrome.ended) throw new Error('CHROME_CLOSE_TIMEOUT');
    } });
  } catch { failed = true; }
  await unlink(socketPath).catch(() => {});
  process.exit(failed ? 1 : code);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
process.once('uncaughtException', () => void shutdown(1));
process.once('unhandledRejection', () => void shutdown(1));

async function main() {
  for (const dir of ['/data/profiles/main', '/data/spool', '/data/artifacts']) await mkdir(dir, { recursive: true, mode: 0o700 });
  // 同一数据卷即使误启第二个容器也失败；不自动删除 Chrome 的 SingletonLock。
  const xvfb = launch('Xvfb', [':99', '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-ac']);
  const html = await readFile(fileURLToPath(new URL('../test/fixtures/safe.html', import.meta.url)));
  fixture = httpServer((req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url !== '/' || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
    res.end(html);
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(8080, '127.0.0.1', resolve); });
  // X11 使用容器内 Unix socket，TCP 不监听；尚无任何 VNC 输入入口。
  await waitFor(async () => {
    const { access } = await import('node:fs/promises');
    try { await access('/tmp/.X11-unix/X99'); return true; } catch { return false; }
  }, [xvfb]);
  const wm = launch('openbox', []);
  await delay(300);
  if (wm.ended) throw new Error('WINDOW_MANAGER_FAILED');
  chrome = launch('google-chrome', [
    '--user-data-dir=/data/profiles/main', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--password-store=basic',
    '--window-size=1440,900', 'about:blank'
  ]);
  await waitFor(async () => {
    try { const response = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(500) }); return response.ok; } catch { return false; }
  }, [], 300);
  controller = new Controller({ desktop, execute, save: async state => {
    const temp = '/data/profiles/worker-state.tmp';
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, '/data/profiles/worker-state.json');
  } });
  await controller.persist();
  // 控制 socket 不放共享卷；仅本容器同 UID 可用。没有 HTTP 管理面或中心服务。
  await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  admission.assertOpen();
  server = controlServer(admission, async request => {
    if (request.command === 'health') {
      if (controller.faulted) throw new Error('UNHEALTHY');
      const cdp = await Cdp.connect(); try { await cdp.send('Browser.getVersion'); } finally { cdp.close(); }
      return { healthy: true };
    }
    return controller.run(request);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  console.log('Page Gather P1 ready; desktop disabled; session unknown.');
}
main().catch(() => { console.error('WORKER_START_FAILED: 检查版本、卷权限、沙箱与显示环境；不会自动禁用沙箱。'); void shutdown(1); });
