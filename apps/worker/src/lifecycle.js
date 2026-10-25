import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 组长退出不代表进程组退出；只有 kill(-pgid, 0) 确认 ESRCH 才移除。
export class ProcessGroups {
  constructor({ spawnProcess = spawn, kill = process.kill.bind(process), onFailure = () => {}, interval = 100, termAttempts = 80, killAttempts = 20 } = {}) {
    Object.assign(this, { spawnProcess, kill, onFailure, interval, termAttempts, killAttempts });
    this.processes = new Set(); this.closed = false; this.stops = new Map();
  }
  seal() { this.closed = true; }
  launch(command, args, critical = true) {
    if (this.closed) throw new Error('SHUTTING_DOWN');
    const child = this.spawnProcess(command, args, { detached: true, stdio: 'ignore' });
    child.ended = false; child.failed = false; this.processes.add(child);
    child.once('error', () => {
      child.failed = true; child.ended = true; this.prune(child);
      if (critical && !this.closed) this.onFailure();
    });
    child.once('exit', () => {
      child.ended = true; this.prune(child);
      if (critical && !this.closed && !child.stopping) this.onFailure();
    });
    return child;
  }
  exists(child) {
    if (!child.pid) return false;
    try { this.kill(-child.pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }
  prune(child) { if (!this.exists(child)) this.processes.delete(child); }
  signal(child, signal) {
    if (!child.pid) return;
    try { this.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  stop(child) {
    if (!child) return Promise.resolve();
    if (this.stops.has(child)) return this.stops.get(child);
    const pending = this.stopGroup(child).finally(() => this.stops.delete(child));
    this.stops.set(child, pending); return pending;
  }
  async stopGroup(child) {
    child.stopping = true; this.signal(child, 'SIGTERM');
    for (let i = 0; i < this.termAttempts && this.exists(child); i++) await delay(this.interval);
    if (this.exists(child)) this.signal(child, 'SIGKILL');
    for (let i = 0; i < this.killAttempts && this.exists(child); i++) await delay(this.interval);
    if (this.exists(child)) throw new Error('PROCESS_STOP_FAILED');
    this.processes.delete(child);
  }
  async stopAll() {
    const results = await Promise.allSettled([...this.processes].reverse().map(child => this.stop(child)));
    if (results.some(result => result.status === 'rejected')) throw new Error('PROCESS_STOP_FAILED');
  }
}

// 同步关门后才取进程快照；等待在途任务完成，再确认最终注册表。
export async function quiesce({ groups, admission, close = async () => {} }) {
  groups.seal(); admission.close();
  const results = await Promise.allSettled([close(), groups.stopAll()]);
  await admission.drain();
  const final = await Promise.allSettled([groups.stopAll()]);
  if ([...results, ...final].some(result => result.status === 'rejected')) throw new Error('SHUTDOWN_FAILED');
}

export class Admission {
  closed = false; tasks = new Set(); sockets = new Set(); servers = new Set();
  assertOpen() { if (this.closed) throw new Error('SHUTTING_DOWN'); }
  run(work) {
    this.assertOpen();
    const pending = Promise.resolve().then(() => { this.assertOpen(); return work(); });
    this.tasks.add(pending);
    pending.then(() => this.tasks.delete(pending), () => this.tasks.delete(pending));
    return pending;
  }
  attach(server) { this.assertOpen(); this.servers.add(server); return server; }
  accept(socket) {
    if (this.closed) { socket.destroy(); return false; }
    this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); return true;
  }
  close() {
    this.closed = true;
    for (const server of this.servers) server.close();
    for (const socket of this.sockets) socket.destroy();
  }
  async drain() { while (this.tasks.size) await Promise.allSettled([...this.tasks]); }
}

export function controlServer(admission, execute) {
  const server = createServer(socket => {
    socket.on('error', () => {});
    if (!admission.accept(socket)) return;
    let input = ''; let received = false;
    socket.setTimeout(60000, () => socket.destroy());
    socket.on('data', chunk => {
      if (received || admission.closed) return;
      input += chunk.toString();
      if (input.length > 16384) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      received = true;
      try {
        void admission.run(() => execute(JSON.parse(input.slice(0, input.indexOf('\n')))))
          .then(result => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, result }) + '\n'); })
          .catch(error => {
            const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'REQUEST_FAILED';
            if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, code }) + '\n');
          });
      } catch { socket.destroy(); }
    });
  });
  return admission.attach(server);
}
