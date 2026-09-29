import { defineConfig, devices } from '@playwright/test';

export const E2E_PORT = 3100;
export const E2E_DIR = '.e2e';

// End-to-end tests run against a production build (`next build` + server.mjs),
// so they see the real CSP. Chromium only: its virtual WebAuthn authenticator
// stands in for a phone's or laptop's passkey.
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
  webServer: {
    command: `rm -rf ${E2E_DIR} && npm run build && node server.mjs`,
    url: `http://localhost:${E2E_PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'ignore',
    env: {
      NODE_ENV: 'production',
      PORT: String(E2E_PORT),
      OC_LISTEN: '127.0.0.1',
      OC_ORIGIN: `http://localhost:${E2E_PORT}`,
      OC_RP_ID: 'localhost',
      OC_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0000',
      OC_DB_PATH: `${E2E_DIR}/portal.db`,
      OC_MAIL: 'outbox',
      OC_MAIL_OUTBOX: `${E2E_DIR}/outbox`,
      OC_ALTCHA_COST: '10',
      OC_ALTCHA_COUNTER_MAX: '50',
    },
  },
});
