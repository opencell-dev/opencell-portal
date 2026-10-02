import { describe, expect, it } from 'vitest';
import { CoreError } from '@/core/types';
import { EPOCH_TOLERANCE_MS, type PageFn, seekAfter, Tail, type TailRow } from '@/lib/noc/tail';

// The tail of an id-ordered list (plan N2a): find where a time window starts
// with few probes, then follow the list one page at a time.

/** A list as a core keeps it: ids rising with gaps (deleted rows), times never going down. */
function list(n: number, gapEvery = 7) {
  const rows: TailRow[] = [];
  let id = 0;
  for (let i = 0; i < n; i++) {
    id += i % gapEvery === 0 ? 3 : 1;
    rows.push({ id, t: 1_000_000 + i * 1000 });
  }
  const calls: [number, number][] = [];
  const page: PageFn<TailRow> = async (after, limit) => {
    calls.push([after, limit]);
    return rows.filter((r) => r.id > after).slice(0, limit);
  };
  return { rows, page, calls };
}

describe('seekAfter', () => {
  it.each([0, 1, 499, 500, 501, 12_345, 99_999])('reaches every row at or after t0 with at most `limit` rows before it (t0 at row %i)', async (k) => {
    const { rows, page, calls } = list(100_000);
    const t0 = rows[k].t;
    const after = await seekAfter(page, t0, 500);
    const got = rows.filter((r) => r.id > after);
    expect(got[0].t).toBeLessThanOrEqual(t0);
    expect(got.findIndex((r) => r.t >= t0)).toBeLessThanOrEqual(500);
    expect(calls.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(100_000 / 500)) + 3);
  });

  it('gives 0 for an empty list or a window that starts before the first row, after one probe', async () => {
    const empty = list(0);
    expect(await seekAfter(empty.page, 5, 500)).toBe(0);
    const { page, calls } = list(10);
    expect(await seekAfter(page, 0, 500)).toBe(0);
    expect(calls).toEqual([[0, 1]]);
  });

  it('ends at the last rows for a window starting after them all', async () => {
    const { rows, page } = list(3000);
    const after = await seekAfter(page, Number.MAX_SAFE_INTEGER, 500);
    expect(rows.filter((r) => r.id > after).length).toBeLessThanOrEqual(500);
  });
});

describe('Tail', () => {
  it('keeps the rows of its window, reading only what is new after the first time', async () => {
    const { rows, page, calls } = list(5000);
    const now = rows[4999].t;
    const tail = new Tail<TailRow>(1_000_000, 500);
    await tail.refresh(page, now, 1);
    expect(tail.rows).toEqual(rows.filter((r) => r.t >= now - 1_000_000));
    expect(tail.complete).toBe(true);
    expect(tail.after).toBe(rows[4999].id);
    rows.push({ id: rows[4999].id + 1, t: now + 1000 });
    calls.length = 0;
    await tail.refresh(page, now + 1000, 1);
    expect(calls).toEqual([[rows[4999].id, 500]]);
    expect(tail.rows.at(-1)).toEqual(rows.at(-1));
    expect(tail.rows[0].t).toBeGreaterThanOrEqual(now + 1000 - 1_000_000);
  });

  it('reads at most maxPages pages a refresh, and says it is not complete', async () => {
    const { rows, page } = list(3000);
    const tail = new Tail<TailRow>(10_000_000, 500, 2);
    await tail.refresh(page, rows[2999].t, 1);
    expect(tail.rows).toHaveLength(1000);
    expect(tail.complete).toBe(false);
    await tail.refresh(page, rows[2999].t, 1);
    await tail.refresh(page, rows[2999].t, 1);
    expect(tail.rows).toHaveLength(3000);
    expect(tail.complete).toBe(false); // the last page was full: only a short (or empty) page says "the end"
    await tail.refresh(page, rows[2999].t, 1);
    expect(tail.rows).toHaveLength(3000);
    expect(tail.complete).toBe(true);
  });

  it('seeks again for a new epoch (the core restarted), and keeps only what `keep` wants', async () => {
    const { rows, page, calls } = list(100);
    const tail = new Tail<TailRow>(10_000_000, 500, 5, (r) => r.id % 2 === 0);
    await tail.refresh(page, rows[99].t, 1);
    expect(tail.rows.every((r) => r.id % 2 === 0)).toBe(true);
    calls.length = 0;
    await tail.refresh(page, rows[99].t, EPOCH_TOLERANCE_MS + 2);
    expect(calls[0]).toEqual([0, 1]);
  });

  it("tolerates jitter in the epoch estimate: a real restart's uptime-based estimate can land on either side of a minute boundary between snapshots (review I3)", async () => {
    const { rows, page, calls } = list(5000);
    const now = rows[4999].t;
    const tail = new Tail<TailRow>(1_000_000, 500);
    await tail.refresh(page, now, 29_833_333); // a start estimated at 29.833 333 s into some minute
    expect(tail.after).toBe(rows[4999].id);
    calls.length = 0;
    await tail.refresh(page, now, 29_833_334); // the same restart, 1 ms of jitter later: not a new epoch
    expect(calls).toEqual([[rows[4999].id, 500]]); // only what is new since last time: no re-seek
  });

  it('treats an epoch more than the tolerance away as a real restart', async () => {
    const { rows, page } = list(5000);
    const now = rows[4999].t;
    const tail = new Tail<TailRow>(1_000_000, 500);
    await tail.refresh(page, now, 0);
    await tail.refresh(page, now, EPOCH_TOLERANCE_MS + 1);
    expect(tail.rows).toEqual(rows.filter((r) => r.t >= now - 1_000_000));
    expect(tail.complete).toBe(true);
  });

  it('runs one refresh at a time', async () => {
    const { rows, page, calls } = list(10);
    const tail = new Tail<TailRow>(10_000_000, 500);
    await Promise.all([tail.refresh(page, rows[9].t, 1), tail.refresh(page, rows[9].t, 1)]);
    expect(calls).toEqual([
      [0, 1],
      [0, 500],
    ]);
    expect(tail.rows).toHaveLength(10);
  });

  it('gives the `after` that starts a page at a time in its window', async () => {
    const { rows, page } = list(100);
    const tail = new Tail<TailRow>(10_000_000, 500);
    expect(tail.afterFor(0)).toBeNull();
    await tail.refresh(page, rows[99].t, 1);
    expect(tail.afterFor(rows[50].t)).toBe(rows[50].id - 1);
    expect(tail.afterFor(rows[99].t + 1)).toBe(rows[99].id);
  });
});

describe('Tail: resuming a rate-limited seek (review I2)', () => {
  /** A list of `n` rows, ids 1..n, one second apart, built formulaically (no array of n entries: n can be large). */
  function bigList(n: number, base = 1_000_000) {
    const page: PageFn<TailRow> = async (after: number, limit: number) => {
      const rows: TailRow[] = [];
      for (let id = after + 1; id <= n && rows.length < limit; id++) rows.push({ id, t: base + (id - 1) * 1000 });
      return rows;
    };
    return { page, base };
  }

  it('keeps its seek progress across a rate-limited attempt instead of restarting at id 0', async () => {
    const n = 2_000_000;
    const { page, base } = bigList(n);
    let tokens = 15;
    let calls = 0;
    const limited: PageFn<TailRow> = async (after, limit) => {
      calls++;
      if (tokens < 1) throw new CoreError('rate_limited', 'audit.list: too many calls this minute');
      tokens--;
      return page(after, limit);
    };
    // The window covers only the newest ~10,000 rows: the seek must walk the
    // whole 2,000,000-row id space to find where it starts (review: "about
    // 24 probes at 2M"), which this token bucket cannot afford in one go.
    const tail = new Tail<TailRow>(10_000_000, 500);
    const now = base + (n - 1) * 1000;
    for (let minute = 0; minute < 40 && tail.after === null; minute++) {
      await tail.refresh(limited, now, 1).catch(() => {});
      tokens += 10; // refill for the next minute
    }
    expect(tail.after).not.toBeNull();
    // A pre-fix seek restarts at id 0 every attempt and never converges (the
    // review's probe: "every attempt failed for 30 simulated minutes, 335
    // calls made"). Resuming converges in a small, bounded number of calls.
    expect(calls).toBeLessThan(100);
  });
});

describe('Tail: a misbehaving core cannot stall it or double-count rows (review M1)', () => {
  it('does not add the same row twice when a page repeats a row instead of advancing past the cursor', async () => {
    const base = 1_000_000;
    const bogus: TailRow = { id: 5, t: base };
    const page: PageFn<TailRow> = async () => [bogus, bogus]; // never advances past id 5, whatever `after` it is asked from
    const tail = new Tail<TailRow>(10_000_000, 500);
    await tail.refresh(page, base, 1);
    const once = tail.rows.length;
    await tail.refresh(page, base, 1);
    expect(tail.rows.length).toBe(once);
  });

  it('never keeps more than `limit` rows from one answer, even if the core sends more', async () => {
    const base = 1_000_000;
    const page: PageFn<TailRow> = async (after) => {
      const rows: TailRow[] = [];
      for (let i = 1; i <= 30; i++) rows.push({ id: after + i, t: base + i * 1000 }); // the limit below is 10; this "core" sends 30
      return rows;
    };
    const tail = new Tail<TailRow>(10_000_000, 10, 1);
    await tail.refresh(page, base + 30_000, 1);
    expect(tail.rows.length).toBeLessThanOrEqual(10);
  });
});
