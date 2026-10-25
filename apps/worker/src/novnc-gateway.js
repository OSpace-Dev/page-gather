import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';

export function parseOrigins(value = 'http://127.0.0.1:6080') {
  const origins = value.split(',').map(item => item.trim());
  if (!origins.length || origins.some(origin => {
    try { const url = new URL(origin); return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin; }
    catch { return true; }
  })) throw new Error('INVALID_NOVNC_ORIGINS');
  return new Set(origins);
}

// 内部 websockify 只监听 loopback；所有外部 upgrade 必须先经过此网关。
export function createNovncGateway({ origins = parseOrigins(), targetPort = 6081, isOpen = () => true } = {}) {
  const sockets = new Set(); let closed = false;
  const track = socket => {
    sockets.add(socket); socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket)); return socket;
  };
  const server = createServer((req, res) => {
    if (closed || !isOpen()) { res.writeHead(503); res.end(); return; }
    const upstream = httpRequest({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('socket', track);
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('connection', socket => { track(socket); if (closed || !isOpen()) socket.destroy(); });
  server.on('upgrade', (req, socket, head) => {
    const originHeaders = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'origin');
    if (closed || !isOpen() || originHeaders.length !== 1 || !origins.has(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    const upstream = track(createConnection({ host: '127.0.0.1', port: targetPort }));
    socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
    upstream.once('connect', () => {
      if (closed || !isOpen() || socket.destroyed) { upstream.destroy(); return; }
      const headers = req.rawHeaders.reduce((lines, value, i, all) => {
        if (i % 2 === 0) lines.push(`${value}: ${all[i + 1]}`); return lines;
      }, []);
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  return {
    server,
    async listen(port = 6080, host = '0.0.0.0') {
      if (closed || !isOpen()) throw new Error('SHUTTING_DOWN');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      if (closed || !isOpen()) { await this.close(); throw new Error('SHUTTING_DOWN'); }
    },
    async close() {
      closed = true;
      const done = new Promise(resolve => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await done;
    }
  };
}
