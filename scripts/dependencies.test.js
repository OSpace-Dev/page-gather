import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoBrowserFrameworks } from './check-dependencies.js';

test('P2前端依赖不放宽直接和间接浏览器框架约束', () => {
  for (const name of ['playwright', '@playwright/test', 'playwright-extra', 'puppeteer-core', '@puppeteer/browsers', 'selenium-webdriver']) {
    assert.throws(() => assertNoBrowserFrameworks({ dependencies: { [name]: '1' } }, { packages: {} }), /BROWSER_FRAMEWORK_FORBIDDEN/);
    assert.throws(() => assertNoBrowserFrameworks({}, { packages: { [`node_modules/${name}`]: { version: '1' } } }), /BROWSER_FRAMEWORK_FORBIDDEN/);
  }
  assertNoBrowserFrameworks({ dependencies: { vue: '3', 'naive-ui': '2' } }, { packages: { 'node_modules/vite': { version: '8' } } });
});
