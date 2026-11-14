// End-to-end checks in a browser (spec, step 22): the real server on a fresh test database with the
// stand-in model (tests/e2e/stand.ts) and the web interface. Needs the development stand: pnpm dev:db.
//   pnpm test:e2e
import { defineConfig, devices } from '@playwright/test';

const WEB = 'http://localhost:8080';
// Readiness by port: an HTTP check would go through a system proxy if one is set.
const SERVER_PORT = 3000;
const WEB_PORT = 8080;

export default defineConfig({
  testDir: 'tests/e2e',
  // One stand with shared state: scenarios run one after another.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'node_modules/.cache/playwright-results',
  use: { baseURL: WEB, locale: 'ru-RU', trace: 'retain-on-failure' },
  projects: [
    // Signs every person of the stand in once: the server allows 5 sign-ins a minute per address.
    { name: 'sign-in', testMatch: 'sign-in.setup.ts', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium', testMatch: '*.spec.ts', dependencies: ['sign-in'], use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'node --env-file=.env tests/e2e/stand.ts',
      port: SERVER_PORT,
      timeout: 120_000,
      reuseExistingServer: false,
      // SIGTERM lets the stand drop its test database (Playwright kills with SIGKILL by default).
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    },
    { command: 'pnpm -C web dev', port: WEB_PORT, timeout: 60_000, reuseExistingServer: false },
  ],
});
