import { defineConfig } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Use the installed Playwright browser by default. A preinstalled browser can be
// selected explicitly for offline developer environments.
const macCache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const cachedBrowser = existsSync(macCache) ? readdirSync(macCache).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse().map(name => path.join(macCache, name, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')).find(file => existsSync(file)) : undefined;
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? cachedBrowser;
const productionURL = process.env.E2E_APP_URL;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: productionURL ? '**/production.spec.ts' : ['**/application.spec.ts', '**/workflows.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: productionURL ? 'test-results/production' : 'test-results/e2e',
  use: {
    baseURL: productionURL ?? 'http://127.0.0.1:3021',
    browserName: 'chromium',
    launchOptions: { executablePath },
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: productionURL ? undefined : {
    command: 'node --import tsx tests/e2e/server.ts',
    url: 'http://127.0.0.1:3021/api/health',
    reuseExistingServer: false,
    timeout: 90_000,
    env: { PORT: '3021' },
  },
});
