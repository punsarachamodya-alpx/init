import { defineConfig } from '@playwright/test';
import { E2E_ENV, E2E_PORT } from './e2e/env.ts';

// The browser installed in this environment is /opt/pw-browsers/chromium-1194, which differs from the build this
// Playwright version expects, so it is launched by path. Override with PLAYWRIGHT_CHROMIUM_PATH elsewhere.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/globalSetup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    launchOptions: { executablePath, args: ['--no-sandbox'] },
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  webServer: {
    command: `pnpm exec next dev -p ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...E2E_ENV, NODE_ENV: 'development' },
  },
});
