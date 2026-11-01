import { describe, expect, it, vi } from 'vitest';
import { CoreError, type CoreHandle } from '@/core/types';
import { tryWithin } from '@/lib/core-ask';

const h = { id: 'c', where: 'test', core: {} } as unknown as CoreHandle;

describe('tryWithin', () => {
  it('the answer, or the error it failed with', async () => {
    expect(await tryWithin(h, 'x', async () => 7, 1000)).toEqual({ ok: true, value: 7 });
    const e = new CoreError('taken');
    expect(await tryWithin(h, 'x', async () => Promise.reject(e), 1000)).toEqual({ ok: false, error: e });
    const sync = () => {
      throw e;
    };
    expect(await tryWithin(h, 'x', sync, 1000)).toEqual({ ok: false, error: e });
  });

  it('late, and the late answer still arrives to onLate (success or failure), once', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const seen: unknown[] = [];
      const slow = (v: () => number) => () => new Promise<number>((res) => setTimeout(() => res(v()), 50));
      const a = tryWithin(h, 'x', slow(() => 1), 10, (r) => seen.push(r));
      await vi.advanceTimersByTimeAsync(10);
      expect(await a).toEqual({ ok: false, late: true });
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(50);
      expect(seen).toEqual([{ ok: true, value: 1 }]);
      const b = tryWithin(h, 'x', () => new Promise<number>((_, rej) => setTimeout(() => rej(new CoreError('invalid')), 50)), 10, (r) => seen.push(r));
      await vi.advanceTimersByTimeAsync(60);
      expect(await b).toEqual({ ok: false, late: true });
      expect(seen[1]).toMatchObject({ ok: false, error: { code: 'invalid' } });
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  });

  it('no onLate when the answer came in time; a throwing onLate does not escape', async () => {
    const onLate = vi.fn();
    expect(await tryWithin(h, 'x', async () => 1, 1000, onLate)).toEqual({ ok: true, value: 1 });
    expect(onLate).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const a = tryWithin(h, 'x', () => new Promise<number>((res) => setTimeout(() => res(1), 50)), 10, () => {
        throw new Error('boom');
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(await a).toEqual({ ok: false, late: true });
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  });

  it('logs rate_limited and unavailable, not an answer like taken', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await tryWithin(h, 'x', async () => Promise.reject(new CoreError('taken')), 1000);
    expect(log).not.toHaveBeenCalled();
    await tryWithin(h, 'x', async () => Promise.reject(new CoreError('rate_limited')), 1000);
    await tryWithin(h, 'x', async () => Promise.reject(new CoreError('unavailable')), 1000);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
