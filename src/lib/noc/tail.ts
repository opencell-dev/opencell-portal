// The newest rows of a list a core keeps by id (cdr.recent, audit.list),
// with only "rows after id N, at most L" to ask with (NOC design §7.1), and
// rows whose time (t) never goes down as the id goes up: the core writes a
// CDR when its call ends and an audit record when it happens. Nothing is
// stored: the cursor and the window's rows live in this process (ruling R1).

export interface TailRow {
  id: number;
  /** Unix ms; never smaller than an earlier id's. */
  t: number;
}

export type PageFn<R extends TailRow> = (after: number, limit: number) => Promise<R[]>;

/**
 * Review I3: `epoch` (the core's estimated start, unix ms) is noisy by
 * about ±1 s (uptimeS is whole seconds; the snapshot's own clock phase adds
 * more), so comparing it for exact equality flaps across whichever instant
 * the jitter happens to cross, clearing the tail and re-seeking on every
 * flap. Treat the epoch as unchanged within this tolerance; only a jump
 * past it (a real restart) seeks again. A real restart does not move ids.
 */
export const EPOCH_TOLERANCE_MS = 2 * 60_000;

/**
 * The seek's progress, one probe's worth of state (review I2): kept outside
 * the loop so a `Tail` can carry it across a probe that throws (a core that
 * is rate-limiting `audit.list`/`cdr.recent` for the next minute or more)
 * instead of restarting the whole seek at id 0 on the next attempt.
 */
export type SeekState = { phase: 'first' } | { phase: 'double'; lo: number; step: number } | { phase: 'halve'; lo: number; hi: number };

/** M1: a core that never reports a time at or after t0 cannot keep the doubling (or halving) loop running forever. */
export const MAX_SEEK_PROBES = 64;

/**
 * One probe of the seek (review I2): advances `state.s` and returns the
 * `after` once found, or `null` to probe again. `state.s` is updated only
 * once `page` resolves, so a throw (a core's rate limit) leaves `state.s`
 * exactly as it was before this probe: the next call to `seekStep` retries
 * it, not the seek from its start.
 */
export async function seekStep<R extends TailRow>(state: { s: SeekState }, page: PageFn<R>, t0: number, limit: number): Promise<number | null> {
  const s = state.s;
  if (s.phase === 'first') {
    const first = await page(0, 1);
    if (first.length === 0 || first[0].t >= t0) return 0;
    state.s = { phase: 'double', lo: first[0].id, step: limit };
    return null;
  }
  if (s.phase === 'double') {
    const x = s.lo + s.step;
    const r = await page(x, 1);
    if (r.length === 0 || r[0].t >= t0) state.s = { phase: 'halve', lo: s.lo, hi: x };
    else state.s = { phase: 'double', lo: r[0].id, step: s.step * 2 };
    return null;
  }
  if (s.hi - s.lo <= limit) return s.lo;
  const mid = s.lo + Math.floor((s.hi - s.lo) / 2);
  const r = await page(mid, 1);
  if (r.length === 0 || r[0].t >= t0) state.s = { phase: 'halve', lo: s.lo, hi: mid };
  else state.s = { phase: 'halve', lo: r[0].id, hi: s.hi };
  return null;
}

/**
 * An `after` from which pages of `limit` reach every row at or after t0,
 * with at most `limit` rows before t0 on the way: one-row probes, doubling
 * from the first row until past t0 (or the end), then halving to within
 * `limit`. About 2 log2(rows / limit) probes, once per cursor (Tail).
 */
export async function seekAfter<R extends TailRow>(page: PageFn<R>, t0: number, limit: number): Promise<number> {
  const state = { s: { phase: 'first' } as SeekState };
  for (let probes = 0; probes < MAX_SEEK_PROBES; probes++) {
    const r = await seekStep(state, page, t0, limit);
    if (r !== null) return r;
  }
  return state.s.phase === 'first' ? 0 : state.s.lo;
}

/**
 * The rows of the last `windowMs` (those `keep` wants), kept up to date one
 * page at a time: the first refresh seeks (seekAfter), later ones read only
 * what is new, at most `maxPages` pages each (`complete` false: more next
 * time). A new `epoch` (the core restarted) seeks again. One refresh runs at
 * a time.
 */
export class Tail<R extends TailRow> {
  private cursor: number | null = null;
  private epoch: number | null = null;
  private inflight: Promise<void> | null = null;
  /** Review I2: the seek's own progress, kept across a refresh that throws (a rate limit), so the next one resumes it. */
  private seekState: SeekState = { phase: 'first' };
  private seekProbes = 0;
  rows: R[] = [];
  complete = false;

  constructor(
    readonly windowMs: number,
    readonly limit: number,
    readonly maxPages = 5,
    /** Which rows of the window to keep (the cursor moves past every row either way). */
    readonly keep: (r: R) => boolean = () => true,
  ) {}

  /** The newest id read (the next refresh reads after it); null before the first seek. */
  get after(): number | null {
    return this.cursor;
  }

  refresh(page: PageFn<R>, now: number, epoch: number): Promise<void> {
    this.inflight ??= this.run(page, now, epoch).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Review I2: one call to `seekStep`, resuming from `this.seekState`; the cap (M1) applies across attempts, not just within one. */
  private async resumeSeek(page: PageFn<R>, t0: number, limit: number): Promise<number> {
    const state = { s: this.seekState };
    for (; this.seekProbes < MAX_SEEK_PROBES; this.seekProbes++) {
      const r = await seekStep(state, page, t0, limit);
      this.seekState = state.s;
      if (r !== null) {
        this.seekProbes = 0;
        this.seekState = { phase: 'first' };
        return r;
      }
    }
    const lo = this.seekState.phase === 'first' ? 0 : this.seekState.lo;
    this.seekProbes = 0;
    this.seekState = { phase: 'first' };
    return lo;
  }

  private async run(page: PageFn<R>, now: number, epoch: number): Promise<void> {
    if (this.epoch === null || Math.abs(epoch - this.epoch) > EPOCH_TOLERANCE_MS) {
      this.cursor = null;
      this.rows = [];
      this.epoch = epoch;
      this.seekState = { phase: 'first' };
      this.seekProbes = 0;
    }
    const t0 = now - this.windowMs;
    if (this.cursor === null) this.cursor = await this.resumeSeek(page, t0, this.limit);
    this.complete = false;
    for (let n = 0; n < this.maxPages; n++) {
      // Review M1: never trust a page past `limit` rows, or a row that does not advance past the cursor (a buggy or malicious
      // core repeating or reordering ids) -- either stalls or double-counts a tail that otherwise keeps no number to re-check.
      const got = (await page(this.cursor, this.limit)).slice(0, this.limit);
      let advanced = false;
      for (const r of got) {
        if (r.id <= this.cursor) continue;
        this.cursor = r.id;
        advanced = true;
        if (r.t >= t0 && this.keep(r)) this.rows.push(r);
      }
      if (!advanced || got.length < this.limit) {
        this.complete = true;
        break;
      }
    }
    this.rows = this.rows.filter((r) => r.t >= t0);
  }

  /** The `after` from which a page starts at the first kept row at or after t (the cursor when none is): null before the first seek. */
  afterFor(t: number): number | null {
    if (this.cursor === null) return null;
    const first = this.rows.find((r) => r.t >= t);
    return first ? first.id - 1 : this.cursor;
  }
}
