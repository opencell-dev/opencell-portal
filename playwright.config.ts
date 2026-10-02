import { defineConfig, devices } from '@playwright/test';

export const E2E_PORT = 3100;
export const E2E_DIR = '.e2e';
// NOC design §N1.5: the same build, run a second time as the NOC's own site,
// with its own database and outbox (tests/e2e/noc.spec.ts).
export const E2E_NOC_PORT = 3101;
export const E2E_NOC_DIR = '.e2e-noc';
// Production bug check (2026-10-02): the same build, with OC_TRUSTED_PROXY
// set to the test runner's own loopback address, so a request carrying
// X-Forwarded-Proto: https (what nginx-proxy/Anubis always send in
// production) is honored exactly as it would be for real. See
// tests/e2e/site-rewrite-proto.spec.ts.
export const E2E_PROTO_PORT = 3102;
export const E2E_PROTO_DIR = '.e2e-proto';
// This server's own stdout+stderr, captured to a file (not 'ignore'd like
// the other two) so a test can check for a specific log line, such as the
// server-action redirect's self-fetch failure this bug also caused
// (console.error in Next's action-handler.js).
export const E2E_PROTO_LOG = '.e2e-proto.log';
// Same, but OC_SITE=noc: the NOC lookup form's server action, forwarded as
// https, through a trusted proxy (tests/e2e/noc-lookup-proto.spec.ts).
export const E2E_NOC_PROTO_PORT = 3103;
export const E2E_NOC_PROTO_DIR = '.e2e-noc-proto';
export const E2E_NOC_PROTO_LOG = '.e2e-noc-proto.log';

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
      command: `rm -rf ${E2E_DIR} ${E2E_NOC_DIR} ${E2E_PROTO_DIR} ${E2E_PROTO_LOG} ${E2E_NOC_PROTO_DIR} ${E2E_NOC_PROTO_LOG} && npm run build && node server.mjs`,
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
    {
      command: `node server.mjs >> ${E2E_PROTO_LOG} 2>&1`,
      url: `http://127.0.0.1:${E2E_PROTO_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(E2E_PROTO_PORT),
        OC_ORIGIN: `http://127.0.0.1:${E2E_PROTO_PORT}`,
        // OC_RP_ID must be the origin host (or a parent domain) -- the
        // origin's host here is the literal IP, not "localhost" (common's
        // default), since the request below must come from exactly the
        // address OC_TRUSTED_PROXY names.
        OC_RP_ID: '127.0.0.1',
        OC_SECRET: 'e2e-proto-secret-e2e-proto-secret-0000',
        OC_DB_PATH: `${E2E_PROTO_DIR}/portal.db`,
        OC_MAIL_OUTBOX: `${E2E_PROTO_DIR}/outbox`,
        // The only difference from the other two servers: this one trusts
        // X-Forwarded-Proto/For/Host from 127.0.0.1, the test runner's own
        // address, as nginx-proxy/Anubis's is trusted in production.
        OC_TRUSTED_PROXY: '127.0.0.1',
      },
    },
    {
      command: `node server.mjs >> ${E2E_NOC_PROTO_LOG} 2>&1`,
      url: `http://127.0.0.1:${E2E_NOC_PROTO_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...common,
        OC_SITE: 'noc',
        OC_CORE: 'fake',
        PORT: String(E2E_NOC_PROTO_PORT),
        OC_ORIGIN: `http://localhost:${E2E_NOC_PROTO_PORT}`,
        OC_SECRET: 'e2e-noc-proto-secret-e2e-noc-proto-0000',
        OC_DB_PATH: `${E2E_NOC_PROTO_DIR}/portal.db`,
        OC_MAIL_OUTBOX: `${E2E_NOC_PROTO_DIR}/outbox`,
        OC_TRUSTED_PROXY: '127.0.0.1',
      },
    },
  ],
});
