import { defineConfig, devices } from '@playwright/test';

export const E2E_PORT = 3100;
export const E2E_DIR = '.e2e';
// NOC design §N1.5: the same build, run a second time as the NOC's own site,
// with its own database and outbox (tests/e2e/noc.spec.ts).
export const E2E_NOC_PORT = 3101;
export const E2E_NOC_DIR = '.e2e-noc';

const common = {
  NODE_ENV: 'production',
  OC_LISTEN: '127.0.0.1',
  OC_RP_ID: 'localhost',
  OC_MAIL: 'outbox',
  OC_ALTCHA_COST: '10',
  OC_ALTCHA_COUNTER_MAX: '50',
};

// End-to-end tests run against a production build (`next build` + server.mjs),
// so they see the real CSP. Chromium only: its virtual WebAuthn authenticator
// stands in for a phone's or laptop's passkey. Playwright starts the web
// servers in order, each once the one before answers, so the second (the
// NOC site) starts on the build the first made.
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: `http://localhost:${E2E_PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: `rm -rf ${E2E_DIR} ${E2E_NOC_DIR} && npm run build && node server.mjs`,
      url: `http://localhost:${E2E_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'ignore',
      env: {
        ...common,
        PORT: String(E2E_PORT),
        OC_ORIGIN: `http://localhost:${E2E_PORT}`,
        OC_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0000',
        OC_DB_PATH: `${E2E_DIR}/portal.db`,
        OC_MAIL_OUTBOX: `${E2E_DIR}/outbox`,
      },
    },
    {
      command: 'node server.mjs',
      url: `http://localhost:${E2E_NOC_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      env: {
        ...common,
        OC_SITE: 'noc',
        PORT: String(E2E_NOC_PORT),
        OC_ORIGIN: `http://localhost:${E2E_NOC_PORT}`,
        OC_SECRET: 'e2e-noc-secret-e2e-noc-secret-e2e-0000',
        OC_DB_PATH: `${E2E_NOC_DIR}/portal.db`,
        OC_MAIL_OUTBOX: `${E2E_NOC_DIR}/outbox`,
      },
    },
  ],
});
