import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, chmod, symlink, unlink, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH } from 'node:crypto';
import { ensureVapidFile, validateVapidKeys, vapidKeysFromBytes } from './generate-vapid.js';

test('固定短EC私钥导出先左补零再编码，不依靠随机重试', () => {
  const curve = createECDH('prime256v1'); curve.setPrivateKey(Buffer.from([1]));
  const raw = curve.getPrivateKey();
  assert.equal(raw.length, 1);
  const pair = vapidKeysFromBytes(raw, curve.getPublicKey());
  const decoded = Buffer.from(pair.privateKey, 'base64url');
  assert.equal(pair.privateKey.length, 43); assert.equal(decoded.length, 32);
  assert.deepEqual(decoded.subarray(0, 31), Buffer.alloc(31)); assert.equal(decoded[31], 1);
  assert.equal(validateVapidKeys(pair), pair);
});
test('VAPID拒绝解码字节相同但非规范的base64url写法', () => {
  const curve = createECDH('prime256v1'); curve.setPrivateKey(Buffer.from([1]));
  const pair = vapidKeysFromBytes(curve.getPrivateKey(), curve.getPublicKey());
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const changed = pair.privateKey.slice(0, -1) + alphabet[alphabet.indexOf(pair.privateKey.at(-1)) + 1];
  assert.deepEqual(Buffer.from(changed, 'base64url'), Buffer.from(pair.privateKey, 'base64url'));
  assert.throws(() => validateVapidKeys({ ...pair, privateKey: changed }), /VAPID_FILE_INVALID/);
});
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'page-gather-vapid-'));
  await chmod(root, 0o700);
  try { await run(join(root, 'vapid.json'), root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('VAPID初始化密钥配对、重复执行不旋转，私钥不作为返回值', async () => fixture(async file => {
  assert.deepEqual(await ensureVapidFile(file), { created: true });
  const before = await readFile(file);
  validateVapidKeys(JSON.parse(before));
  assert.deepEqual(await ensureVapidFile(file), { created: false });
  assert.deepEqual(await readFile(file), before);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
}));
test('VAPID已有坏文件不被覆盖', async () => fixture(async file => {
  await writeFile(file, 'synthetic-invalid', { mode: 0o600 });
  await assert.rejects(ensureVapidFile(file));
  assert.equal(await readFile(file, 'utf8'), 'synthetic-invalid');
}));
test('VAPID私钥与公钥不配对时拒绝', async () => fixture(async (file, root) => {
  const other = join(root, 'other.json');
  await ensureVapidFile(file); await ensureVapidFile(other);
  const a = JSON.parse(await readFile(file)); const b = JSON.parse(await readFile(other));
  assert.throws(() => validateVapidKeys({ publicKey: a.publicKey, privateKey: b.privateKey }), /VAPID_FILE_INVALID/);
}));
test('VAPID初始化拒绝符号链接且不修改原文件', { skip: process.platform === 'win32' ? 'Windows开发权限不保证允许创建symlink，Linux复跑' : false }, async () => fixture(async (file, root) => {
  const original = join(root, 'original.json'); await ensureVapidFile(original);
  const before = await readFile(original); await symlink(original, file);
  await assert.rejects(ensureVapidFile(file)); assert.deepEqual(await readFile(original), before);
  await unlink(file);
}));
