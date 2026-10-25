import { validateProbe, validateUrl } from './cdp.js';

export class Controller {
  constructor({ desktop, execute, save = async () => {} }) {
    this.desktop = desktop; this.execute = execute; this.save = save;
    // 每次启动重新确认；历史状态文件只用于诊断，绝不作为登录有效依据。
    this.mode = 'PAUSED'; this.session = { status: 'unknown', checkedAt: null };
    this.busy = false; this.faulted = false;
  }
  status() { return { mode: this.mode, session: this.session, busy: this.busy, faulted: this.faulted }; }
  async persist() { await this.save(this.status()); }
  async run(request) {
    if (!request || typeof request !== 'object') throw new Error('INVALID_REQUEST');
    const { command } = request;
    if (command === 'status') return this.status();
    if (this.busy) throw new Error('WORKER_BUSY');
    if (this.faulted) throw new Error('WORKER_RESTART_REQUIRED');
    if (!['manual-start', 'manual-finish', 'connect', 'navigate', 'read', 'screenshot', 'probe'].includes(command)) throw new Error('UNKNOWN_COMMAND');
    if (command === 'probe' || request.probe) validateProbe(request.probe);
    if (request.url !== undefined) validateUrl(request.url);
    if (command === 'read' && (typeof request.selector !== 'string' || request.selector.length > 500)) throw new Error('INVALID_SELECTOR');
    this.busy = true;
    try {
      if (command === 'manual-start') {
        if (this.mode === 'MANUAL') throw new Error('ALREADY_MANUAL');
        this.mode = 'MANUAL_REQUESTED'; this.session = { status: 'unknown', checkedAt: null };
        await this.persist();
        await this.desktop.start();
        this.mode = 'MANUAL'; await this.persist();
        return this.status();
      }
      if (command === 'manual-finish') {
        if (this.mode !== 'MANUAL') throw new Error('NOT_MANUAL');
        this.mode = 'RECOVERING';
        // 关闭已有 WebSocket/VNC 进程组并确认退出后才能发送任何 CDP 命令。
        await this.desktop.stop();
        if (request.probe) {
          this.session = await this.execute({ command: 'probe', probe: request.probe });
          this.mode = this.session.status === 'valid' ? 'AUTO' : 'PAUSED';
        } else {
          this.session = { status: 'unknown', checkedAt: null }; this.mode = 'PAUSED';
        }
        await this.persist(); return this.status();
      }
      if (this.mode === 'MANUAL') throw new Error('MANUAL_ACTIVE');
      const result = await this.execute(request);
      if (command === 'probe') {
        this.session = result; this.mode = result.status === 'valid' ? 'AUTO' : 'PAUSED';
        await this.persist();
      }
      return result;
    } catch (error) {
      if (!['MANUAL_ACTIVE', 'ALREADY_MANUAL', 'NOT_MANUAL'].includes(error.message)) {
        this.mode = 'PAUSED'; this.session = { status: 'unknown', checkedAt: new Date().toISOString() };
        // 任一异常先撤销人工输入；撤销失败永不放行自动操作。
        try { await this.desktop.stop(); } catch { this.faulted = true; }
        if (error.message === 'TARGET_CLEANUP_FAILED') this.faulted = true;
        try { await this.persist(); } catch { this.faulted = true; }
      }
      throw error;
    } finally { this.busy = false; }
  }
}
