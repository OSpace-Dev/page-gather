import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const rules = [
  new RegExp('(?:^|[^A-Za-z0-9])[A-Za-z]:/'),
  new RegExp('/(?:Users|home)/[^ /<>$]+/'),
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{24,})/
];
// JSON 带引号键、YAML、dotenv/export；值允许常用标点，不只字母数字。
const credential = /(?:^|[\s{,;])(?:export\s+)?(?:(["'])((?:[\w-]*[_-])?(?:password|token|secret|api[_-]?key))\1|((?:[\w-]*[_-])?(?:password|token|secret|api[_-]?key)))\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\$\{[^}\r\n]+\}|[^\s,;#}\r\n]+))/gi;
export function hasSensitivePattern(line) {
  const normalized = line.split(String.fromCharCode(92)).join('/');
  if (rules.some(rule => rule.test(normalized))) return true;
  for (const match of line.matchAll(credential)) {
    const value = match[4] ?? match[5] ?? match[6];
    if (value.length >= 16 && !/^(?:\$\{[^}]+\}|<[^>]+>|process\.env\.[A-Z_][A-Z_0-9]*)$/.test(value)) return true;
  }
  return false;
}
export function checkPrivacy() {
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split(String.fromCharCode(0)).filter(Boolean);
let findings = 0;
for (const path of paths) {
  if (path === 'scripts/check-privacy.js' || ['.png', '.jpg', '.gif', '.webp'].some(ext => path.endsWith(ext))) continue;
  const content = readFileSync(path, 'utf8');
  content.split(String.fromCharCode(10)).forEach((line, index) => {
    if (hasSensitivePattern(line)) {
      // 只输出相对文件名与行号，绝不回显匹配的敏感内容。
      console.error(`${path}:${index + 1}: 待审查敏感模式`); findings++;
    }
  });
}
if (findings) process.exitCode = 1;
else console.log(`敏感模式扫描通过：${paths.length} 个文件；启发式检查不替代人工审查。`);
return findings;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkPrivacy();
