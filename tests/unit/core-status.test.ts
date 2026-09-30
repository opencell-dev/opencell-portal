import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeCore } from '@/core/fake';
import { CoreError, type CoreHandle } from '@/core/types';
import { coreStatuses } from '@/lib/core-status';
import { testCtx } from '../helpers/ctx';

afterEach(() => vi.restoreAllMocks());

/** A test context with a second fake core, as OC_CORES=core1,core2 would give. */
function twoCores() {
  const ctx = testCtx();
  const core2 = new FakeCore();
  const cores: CoreHandle[] = [ctx.cores[0], { id: 'core2', where: '10.99.0.2:7444', core: core2 }];
  return { ctx: { ...ctx, cores }, core2 };
}

describe('the cores for the admin dashboard', () => {
  it("is each core's answer, in config order", async () => {
    const { ctx } = twoCores();
    const rows = await coreStatuses(ctx, 1);
    expect(rows.map((r) => [r.id, r.where, r.status?.name])).toEqual([
      ['fake', 'in-process', 'fake-core'],
      ['core2', '10.99.0.2:7444', 'fake-core'],
    ]);
  });

  it('marks a core that fails unreachable, logs why, and still shows the others', async () => {
    const { ctx, core2 } = twoCores();
    const boom = new CoreError('unavailable', 'connect ECONNREFUSED 10.99.0.2:7444');
    vi.spyOn(core2, 'coreStatus').mockRejectedValue(boom);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = await coreStatuses(ctx, 1);
    expect(rows[0].status).toMatchObject({ name: 'fake-core' });
    expect(rows[1]).toEqual({ id: 'core2', where: '10.99.0.2:7444', status: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('core2'), boom);
  });

  it('waits no longer than the deadline for a core that never answers', async () => {
    const { ctx, core2 } = twoCores();
    vi.spyOn(core2, 'coreStatus').mockReturnValue(new Promise(() => {}));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t0 = Date.now();
    const rows = await coreStatuses(ctx, 1, 200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(rows[0].status).not.toBeNull();
    expect(rows[1].status).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('core2'));
  });

  it('still logs why a core failed after the deadline', async () => {
    const { ctx, core2 } = twoCores();
    const late = new CoreError('unavailable', 'the core did not answer in time');
    vi.spyOn(core2, 'coreStatus').mockReturnValue(new Promise((_, reject) => setTimeout(() => reject(late), 150)));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = await coreStatuses(ctx, 1, 50);
    expect(rows[1].status).toBeNull();
    await new Promise((r) => setTimeout(r, 250));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('core2 (10.99.0.2:7444) status failed'), late);
  });

  it("passes the admin's account id to every core (each core's audit)", async () => {
    const { ctx, core2 } = twoCores();
    const a = vi.spyOn(ctx.cores[0].core, 'coreStatus');
    const b = vi.spyOn(core2, 'coreStatus');
    await coreStatuses(ctx, 42);
    expect(a).toHaveBeenCalledWith(42);
    expect(b).toHaveBeenCalledWith(42);
  });

  it('gives null, not a rejection, when a core client throws synchronously (review M3)', async () => {
    const { ctx, core2 } = twoCores();
    vi.spyOn(core2, 'coreStatus').mockImplementation(() => {
      throw new Error('sync boom');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = await coreStatuses(ctx, 1);
    expect(rows[0].status).toMatchObject({ name: 'fake-core' });
    expect(rows[1]).toEqual({ id: 'core2', where: '10.99.0.2:7444', status: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('core2'), expect.any(Error));
  });

  it('leaves no timer running and logs nothing once every core has answered (review M4)', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = twoCores();
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const rows = await coreStatuses(ctx, 1);
      expect(rows.every((r) => r.status !== null)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(log).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
