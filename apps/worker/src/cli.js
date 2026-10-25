import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateProbe, validateUrl } from './cdp.js';

export async function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['health', 'status', 'manual-start', 'manual-finish', 'connect', 'navigate', 'read', 'screenshot', 'probe'].includes(command)) throw new Error('INVALID_COMMAND');
  const allowed = { navigate: ['url'], read: ['url', 'selector'], screenshot: ['url'], probe: ['config'], 'manual-finish': ['config'] }[command] || [];
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '');
    if (rest[i] !== `--${key}` || !allowed.includes(key) || options[key] !== undefined || !rest[i + 1]) throw new Error('INVALID_ARGUMENT');
    options[key] = rest[i + 1];
  }
  const request = { command };
  if (options.url) request.url = validateUrl(options.url);
  if (command === 'read') {
    if (!options.selector || options.selector.length > 500) throw new Error('SELECTOR_REQUIRED');
    request.selector = options.selector;
  }
  if (command === 'probe' && !options.config) throw new Error('CONFIG_REQUIRED');
  if (options.config) {
    const content = await readFile(options.config, 'utf8');
    if (content.length > 10000) throw new Error('CONFIG_TOO_LARGE');
    request.probe = validateProbe(JSON.parse(content));
  }
  return request;
}
export function requestWorker(request, socketPath = process.env.PAGE_GATHER_SOCKET || '/run/page-gather/control.sock', timeout = 55000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); let input = '';
    socket.setEncoding('utf8');
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('WORKER_TIMEOUT')); }, timeout);
    const finish = () => clearTimeout(timer);
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 65536) { finish(); socket.destroy(); reject(new Error('RESPONSE_TOO_LARGE')); return; }
      if (!input.includes('\n')) return;
      finish(); socket.destroy();
      try {
        const response = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (!response.ok) reject(new Error(response.code)); else resolve(response.result);
      } catch { reject(new Error('INVALID_RESPONSE')); }
    });
    socket.once('error', () => { finish(); reject(new Error('WORKER_UNAVAILABLE')); });
    socket.once('close', () => { finish(); reject(new Error('WORKER_CONNECTION_CLOSED')); });
  });
}
async function main() {
  try {
    const result = await requestWorker(await parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'CLI_FAILED');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
