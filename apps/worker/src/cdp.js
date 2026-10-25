import { EventEmitter } from 'node:events';

export class Cdp extends EventEmitter {
  constructor(ws, timeout = 10000) {
    super();
    this.ws = ws; this.timeout = timeout; this.nextId = 0; this.pending = new Map();
    ws.addEventListener('message', ({ data }) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { this.close(); return; }
      if (msg.id) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error('CDP_COMMAND_FAILED'));
        else pending.resolve(msg.result);
      } else this.emit('event', msg);
    });
    const fail = () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP_DISCONNECTED')); }
      this.pending.clear();
    };
    ws.addEventListener('close', fail); ws.addEventListener('error', fail);
  }
  static async connect(endpoint = 'http://127.0.0.1:9222', timeout = 10000) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('CDP_LOOPBACK_ONLY');
    const response = await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(timeout), redirect: 'error' });
    if (!response.ok) throw new Error('CDP_DISCOVERY_FAILED');
    const info = await response.json();
    const wsUrl = new URL(info.webSocketDebuggerUrl);
    if (wsUrl.protocol !== 'ws:' || wsUrl.hostname !== '127.0.0.1' || wsUrl.port !== url.port || wsUrl.username || wsUrl.password) throw new Error('CDP_LOOPBACK_ONLY');
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP_CONNECT_TIMEOUT')); }, timeout);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_CONNECT_FAILED')); }, { once: true });
    });
    return new Cdp(ws, timeout);
  }
  send(method, params = {}, sessionId) {
    if (this.ws.readyState !== 1) return Promise.reject(new Error('CDP_DISCONNECTED'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP_COMMAND_TIMEOUT')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('CDP_SEND_FAILED')); }
    });
  }
  close() { this.ws.close(); }
}

// 仅打开调用方明确指定的 URL；不支持任意 JS/点击/凭据读取接口。
export function validateUrl(value) {
  if (value === 'about:blank') return value;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL_NOT_ALLOWED');
  return url.href;
}

export function validateProbe(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('INVALID_PROBE');
  if (typeof config.url !== 'string' || !config.url.trim()) throw new Error('INVALID_PROBE');
  validateUrl(config.url);
  if (config.url === 'about:blank') throw new Error('PROBE_REQUIRES_SITE');
  for (const key of ['validSelector', 'loginSelector', 'challengeSelector']) {
    if (typeof config[key] !== 'string' || !config[key].trim() || config[key].length > 500) throw new Error('INVALID_PROBE');
  }
  return config;
}

export function classifyProbe(evidence) {
  if (evidence.challenge) return 'challenge_required';
  if (evidence.login) return 'login_required';
  if (evidence.valid) return 'valid';
  return 'unknown';
}

export class CdpPage {
  constructor(cdp, targetId, sessionId) { this.cdp = cdp; this.targetId = targetId; this.sessionId = sessionId; }
  static async create(cdp) {
    let targetId;
    try { ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })); }
    catch { throw new Error('TARGET_CLEANUP_FAILED'); }
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const page = new CdpPage(cdp, targetId, sessionId);
      await page.send('Page.enable');
      await page.send('Page.setLifecycleEventsEnabled', { enabled: true });
      return page;
    } catch (error) {
      try {
        const result = await cdp.send('Target.closeTarget', { targetId });
        if (!result.success) throw new Error('TARGET_CLEANUP_FAILED');
      } catch { throw new Error('TARGET_CLEANUP_FAILED'); }
      throw error;
    }
  }
  send(method, params) { return this.cdp.send(method, params, this.sessionId); }
  async navigate(url = 'about:blank', timeout = 15000) {
    validateUrl(url);
    const events = new Set();
    let loader; let done;
    const loaded = new Promise(resolve => { done = resolve; });
    const listener = msg => {
      if (msg.sessionId === this.sessionId && msg.method === 'Page.lifecycleEvent' && msg.params.name === 'load') {
        events.add(msg.params.loaderId); if (loader === msg.params.loaderId) done();
      }
    };
    this.cdp.on('event', listener);
    let timer;
    try {
      const nav = await this.send('Page.navigate', { url });
      if (nav.errorText || nav.isDownload) throw new Error('NAVIGATION_FAILED');
      loader = nav.loaderId;
      if (loader && !events.has(loader)) {
        await Promise.race([loaded, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('NAVIGATION_TIMEOUT')), timeout); })]);
      }
    } finally { clearTimeout(timer); this.cdp.off('event', listener); }
  }
  async evaluateRead(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, timeout: 5000 });
    if (result.exceptionDetails) throw new Error('READ_FAILED');
    return result.result.value;
  }
  async readText(selector) {
    if (typeof selector !== 'string' || selector.length > 500) throw new Error('INVALID_SELECTOR');
    return this.evaluateRead(`document.querySelector(${JSON.stringify(selector)})?.textContent?.slice(0, 4096) ?? null`);
  }
  async probe(config) {
    validateProbe(config);
    await this.navigate(config.url);
    const selectors = [config.validSelector, config.loginSelector, config.challengeSelector];
    // 不读取 cookie、账号文字或任意用户表达式；只返回 DOM 存在性与同源判断。
    const evidence = await this.evaluateRead(`(() => {
      const sameOrigin = location.origin === ${JSON.stringify(new URL(config.url).origin)};
      const matches = ${JSON.stringify(selectors)}.map(s => Boolean(document.querySelector(s)));
      return { sameOrigin, valid: matches[0], login: matches[1], challenge: matches[2] };
    })()`);
    return { status: evidence?.sameOrigin ? classifyProbe(evidence) : 'unknown', checkedAt: new Date().toISOString() };
  }
  async screenshot() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(data, 'base64');
  }
  async close() {
    const result = await this.cdp.send('Target.closeTarget', { targetId: this.targetId });
    if (!result.success) throw new Error('TARGET_CLEANUP_FAILED');
  }
}
