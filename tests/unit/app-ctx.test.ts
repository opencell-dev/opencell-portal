import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Housekeeping (final review, minor 1) starts with the server's context: once
// per process, not per call, and not for the admin CLI's own context.
const started = vi.fn();
vi.mock('@/lib/housekeeping', () => ({ startHousekeeping: (...a: unknown[]) => started(...a) }));

const ENV = {
  OC_ORIGIN: 'https://portal.test',
  OC_RP_ID: 'portal.test',
  OC_SECRET: 'test-secret-test-secret-test-secret-0123',
  OC_DB_PATH: ':memory:',
  OC_MAIL: 'outbox',
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  delete (globalThis as { __ocCtx?: unknown }).__ocCtx;
  delete (globalThis as { __ocCore?: unknown }).__ocCore;
  started.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { __ocCtx?: unknown }).__ocCtx;
  delete (globalThis as { __ocCore?: unknown }).__ocCore;
});

describe('the process context', () => {
  it('starts housekeeping once, when the server context is first built', async () => {
    const { appCtx } = await import('@/lib/ctx');
    const ctx = appCtx();
    expect(appCtx()).toBe(ctx);
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith(ctx);
  });

  it('uses the real core over TLS when OC_CORE=tls, without connecting yet', async () => {
    vi.resetModules(); // config() is read once per module instance
    vi.stubEnv('OC_CORE', 'tls');
    vi.stubEnv('OC_CORE_ADDR', '127.0.0.1:1');
    vi.stubEnv('OC_CORE_CA', '/nonexistent/ca.crt');
    vi.stubEnv('OC_CORE_CERT', '/nonexistent/portal.crt');
    vi.stubEnv('OC_CORE_KEY', '/nonexistent/portal.key');
    const { createCtx } = await import('@/lib/ctx');
    const { TlsCore } = await import('@/core/tls-client');
    const ctx = createCtx(); // the CLI's: files are read at the first call, never here
    expect(ctx.core).toBeInstanceOf(TlsCore);
    await expect(ctx.core.coreStatus(0)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('does not start it for a context of its own (the admin CLI)', async () => {
    const { createCtx } = await import('@/lib/ctx');
    createCtx();
    expect(started).not.toHaveBeenCalled();
  });
});
