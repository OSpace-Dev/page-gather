// 从已留存的 Moby 官方基线确定性派生；--check 只读校验，不联网。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const directory = new URL('../infra/browser/seccomp/', import.meta.url);
const upstream = await readFile(new URL('moby-v28.3.3-default.json', directory));
assert.equal(createHash('sha256').update(upstream).digest('hex'),
  '01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28', '官方基线发生变化，必须重新审阅');
const profile = JSON.parse(upstream);
// Moby 原 clone namespace mask=0x7e020000；只移除 USER/PID/NET 三位。
const namespaceMask = 0x7e020000;
const chromeNamespaces = 0x10000000 | 0x20000000 | 0x40000000;
profile.syscalls.push({
  names: ['clone'], action: 'SCMP_ACT_ALLOW',
  args: [{ index: 0, value: namespaceMask & ~chromeNamespaces, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }],
  includes: { arches: ['amd64'] },
  comment: 'Page Gather amd64: allow only USER/PID/NET namespace flags; retain default denial of other namespace flags.'
}, {
  names: ['unshare'], action: 'SCMP_ACT_ALLOW',
  args: [{ index: 0, value: 0x10000000, op: 'SCMP_CMP_EQ' }],
  includes: { arches: ['amd64'] },
  comment: 'Page Gather amd64: allow only CLONE_NEWUSER; no setns or clone3 exception.'
});
const target = new URL('chrome-userns-amd64.json', directory);
const generated = JSON.stringify(profile, null, 2) + '\n';
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--check'));
if (process.argv[2] === '--check') assert.equal(await readFile(target, 'utf8'), generated, '派生 profile 与审阅规则不一致');
else await writeFile(target, generated);
console.log('seccomp profile: 官方基线 SHA256 与两条 amd64 例外一致');
