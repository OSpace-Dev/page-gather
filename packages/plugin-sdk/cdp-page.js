import { fail } from './index.js';

function allowed(value, domains) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && domains.includes(url.hostname);
  } catch { return false; }
}

// 只适配已由宿主独占并创建的 CdpPage，不连接浏览器、不管理 controller 模式。
// 租约期间阻止图片和跨域请求，包括跨域导航重定向，不跟随 README 外链。
export async function withCdpPage(page, fn, { signal, deadline, allowedDomains = ['github.com'] } = {}) {
  const ownSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, Math.min(2147483647, deadline - Date.now())))]);
  let response = null; let failure = null; let topFrame; let closing = false;
  const check = () => {
    if (ownSignal.aborted || closing) throw fail(signal?.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED');
  };
  const pending = new Set();
  const event = message => {
    if (closing || message.sessionId !== page.sessionId) return;
    if (message.method === 'Network.responseReceived' && message.params.type === 'Document' && message.params.frameId === topFrame) {
      const r = message.params.response;
      response = { status: r.status, url: r.url, retryAfter: Object.entries(r.headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1] };
    }
    if (message.method !== 'Fetch.requestPaused') return;
    const p = message.params;
    const safe = !ownSignal.aborted && p.resourceType !== 'Image' && allowed(p.request.url, allowedDomains);
    const operation = page.send(safe ? 'Fetch.continueRequest' : 'Fetch.failRequest', safe ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' });
    pending.add(operation);
    operation.catch(() => { failure = fail('CDP_DISCONNECTED'); }).finally(() => pending.delete(operation));
  };
  const guard = async operation => {
    check();
    let abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { check(); return operation(); }),
        new Promise((_, reject) => {
          abort = () => { void page.send('Page.stopLoading').catch(() => {}); reject(fail(signal?.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED')); };
          ownSignal.addEventListener('abort', abort, { once: true });
        })
      ]);
    } finally { ownSignal.removeEventListener('abort', abort); }
  };
  page.cdp.on('event', event);
  try {
    // 每条初始化命令单独受限；取消后 pending 命令即使晚返回也没有后续初始化链。
    const { frameTree } = await guard(() => page.send('Page.getFrameTree'));
    check(); topFrame = frameTree.frame.id;
    await guard(() => page.send('Network.enable'));
    await guard(() => page.send('Network.setCacheDisabled', { cacheDisabled: true }));
    await guard(() => page.send('Network.setBypassServiceWorker', { bypass: true }));
    await guard(() => page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }));
    check();
    return await fn({
      async navigate(url) {
        if (!allowed(url, allowedDomains)) throw fail('UNSAFE_URL');
        response = null;
        await guard(() => page.navigate(url, Math.min(15000, Math.max(1, deadline - Date.now()))));
        if (failure) throw failure;
        if (!response) throw fail('NETWORK_TRANSIENT');
        if (!allowed(response.url, allowedDomains)) throw fail('UNSAFE_URL');
        return response;
      },
      evaluateRead: expression => guard(() => page.evaluateRead(expression))
    });
  } finally {
    closing = true;
    // 宿主随后关闭任务 target；取消时不允许在租约外复用页面。
    await Promise.allSettled([...pending]);
    try { await page.send('Fetch.disable'); }
    finally { page.cdp.off('event', event); }
  }
}
