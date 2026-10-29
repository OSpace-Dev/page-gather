import { createECDH, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, parse, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = () => new Error('VAPID_FILE_INVALID');
export function validateVapidKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'privateKey,publicKey') throw fail();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value.privateKey ?? '') || !/^[A-Za-z0-9_-]{87}$/.test(value.publicKey ?? '')) throw fail();
  const privateKey = Buffer.from(value.privateKey, 'base64url'); const publicKey = Buffer.from(value.publicKey, 'base64url');
  if (privateKey.length !== 32 || publicKey.length !== 65 || publicKey[0] !== 4 ||
    privateKey.toString('base64url') !== value.privateKey || publicKey.toString('base64url') !== value.publicKey) throw fail();
  const curve = createECDH('prime256v1'); curve.setPrivateKey(privateKey);
  if (!timingSafeEqual(curve.getPublicKey(), publicKey)) throw fail();
  return value;
}
// OpenSSL可省略EC私钥前导零；VAPID要求固定32字节，必须在编码前左补零。
export function vapidKeysFromBytes(privateBytes, publicBytes) {
  if (!Buffer.isBuffer(privateBytes) || privateBytes.length < 1 || privateBytes.length > 32 || !Buffer.isBuffer(publicBytes)) throw fail();
  const padded = Buffer.alloc(32);
  privateBytes.copy(padded, 32 - privateBytes.length);
  return validateVapidKeys({ publicKey: publicBytes.toString('base64url'), privateKey: padded.toString('base64url') });
}
async function parentDirectory(filename) {
  const parent = dirname(filename); let current = parse(parent).root;
  for (const part of parent.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail();
  }
  const info = await lstat(parent);
  if (process.platform !== 'win32' && ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid())) throw fail();
}
// filename仅来自部署工具的受信配置，不是API或任务参数；不自动修权、覆盖或轮换。
export async function ensureVapidFile(filename = '/data/config/vapid.json') {
  filename = resolve(filename); await parentDirectory(filename);
  let file;
  try {
    file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw fail();
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 4096 ||
      (process.platform !== 'win32' && ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()))) throw fail();
    const existing = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { validateVapidKeys(JSON.parse(await existing.readFile('utf8'))); } finally { await existing.close(); }
    return { created: false };
  }
  try {
    const curve = createECDH('prime256v1'); curve.generateKeys();
    const keys = vapidKeysFromBytes(curve.getPrivateKey(), curve.getPublicKey());
    await file.writeFile(JSON.stringify(keys) + '\n'); await file.sync();
  } catch {
    await file.close(); await unlink(filename).catch(() => {}); throw fail();
  }
  await file.close(); return { created: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw fail();
    const result = await ensureVapidFile();
    console.log(result.created ? 'VAPID密钥已生成，保存在私有配置文件；未输出密钥。' : 'VAPID私有配置已存在并通过校验；未轮换或输出密钥。');
  } catch { console.error('VAPID初始化失败：检查目录/文件权限、链接边界和密钥配对；未覆盖已有配置。'); process.exitCode = 1; }
}
