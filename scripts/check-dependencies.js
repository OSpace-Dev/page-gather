import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
export function checkDependencies(pkg, lock) {
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (Object.keys(pkg[key] || {}).length) throw new Error('P1_ZERO_DEPENDENCIES_REQUIRED');
  }
  if (lock.lockfileVersion !== 3 || Object.keys(lock.packages || {}).some(key => key !== '')) throw new Error('LOCK_CONTAINS_DEPENDENCIES');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (Object.keys(lock.packages?.['']?.[key] || {}).length) throw new Error('LOCK_CONTAINS_DEPENDENCIES');
  }
  if (Object.keys(lock.dependencies || {}).length) throw new Error('LOCK_CONTAINS_DEPENDENCIES');
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'node_modules', 'data'].includes(entry.name)) return [];
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : [path];
  });
}
export function checkRepository() {
  const manifests = walk('.').filter(path => path.endsWith('/package.json'));
  if (manifests.length !== 1) throw new Error('UNREVIEWED_PACKAGE_MANIFEST');
  checkDependencies(JSON.parse(readFileSync('package.json')), JSON.parse(readFileSync('package-lock.json')));
  // 零运行和开发依赖的允许清单同时阻止直接/间接浏览器框架。
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/check-dependencies.js')) {
  checkRepository(); console.log('依赖检查通过：零第三方包、无间接依赖。');
}
