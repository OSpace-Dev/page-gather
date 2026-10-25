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
    if (['.git', 'node_modules', 'data', 'backups', 'dist', '__pycache__'].includes(entry.name)) return [];
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : [path];
  });
}
export function assertNoBrowserFrameworks(pkg, lock) {
  const banned = /playwright|puppeteer|selenium|webdriver|cypress|nightwatch|chromedriver|geckodriver/i;
  const names = Object.keys(lock.packages || {});
  for (const current of [pkg, ...Object.values(lock.packages || {})]) {
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      names.push(...Object.keys(current[key] || {}));
    }
    if (current.name) names.push(current.name);
  }
  if (names.some(name => banned.test(name))) throw new Error('BROWSER_FRAMEWORK_FORBIDDEN');
}
export function checkRepository() {
  const manifests = walk('.').filter(path => path.endsWith('/package.json')).sort();
  const allowedManifests = ['./apps/web/package.json', './package.json'];
  if (manifests.some(path => !allowedManifests.includes(path))) throw new Error('UNREVIEWED_PACKAGE_MANIFEST');
  const pkg = JSON.parse(readFileSync('package.json'));
  const lock = JSON.parse(readFileSync('package-lock.json'));
  if (lock.lockfileVersion !== 3) throw new Error('LOCK_VERSION_REQUIRED');
  assertNoBrowserFrameworks(pkg, lock);
  for (const path of manifests) assertNoBrowserFrameworks(JSON.parse(readFileSync(path)), lock);
  // P2仅允许已审阅的Vue静态前端直接依赖；server/worker仍为Node原生实现。
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (Object.keys(pkg[key] || {}).length) throw new Error('ROOT_DEPENDENCIES_NOT_ALLOWED');
  }
  if (manifests.includes('./apps/web/package.json')) {
    const web = JSON.parse(readFileSync('apps/web/package.json'));
    const allowed = new Set(['vue', 'vue-router', 'naive-ui', 'vite', 'typescript', 'vue-tsc', '@vitejs/plugin-vue']);
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(web[key] || {})) if (!allowed.has(name)) throw new Error('UNREVIEWED_WEB_DEPENDENCY');
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/check-dependencies.js')) {
  checkRepository(); console.log('依赖检查通过：server/worker使用Node原生能力，前端仅允许已审阅依赖，无禁止浏览器框架。');
}
