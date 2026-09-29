import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreStatusOrNull } from '@/lib/core-status';
import { testCtx } from '../helpers/ctx';

afterEach(() => vi.restoreAllMocks());

describe('core status for the admin page', () => {
  it("is the core's answer when it answers", async () => {
    const ctx = testCtx();
    expect(await coreStatusOrNull(ctx, 1)).toMatchObject({ name: 'fake-core' });
  });

  it('is null when the core is unreachable, and the error is logged, not shown', async () => {
    const ctx = testCtx();
    const boom = new Error('connect ECONNREFUSED 10.0.0.60:8443');
    vi.spyOn(ctx.core, 'coreStatus').mockRejectedValue(boom);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await coreStatusOrNull(ctx, 1)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('core status'), boom);
  });
});
