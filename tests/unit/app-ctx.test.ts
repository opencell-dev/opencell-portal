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
  started.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { __ocCtx?: unknown }).__ocCtx;
});

describe('the process context', () => {
  it('starts housekeeping once, when the server context is first built', async () => {
    const { appCtx } = await import('@/lib/ctx');
    const ctx = appCtx();
    expect(appCtx()).toBe(ctx);
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith(ctx);
  });

  it('does not start it for a context of its own (the admin CLI)', async () => {
    const { createCtx } = await import('@/lib/ctx');
    createCtx();
    expect(started).not.toHaveBeenCalled();
  });
});
