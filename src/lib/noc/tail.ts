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
 * An `after` from which pages of `limit` reach every row at or after t0,
 * with at most `limit` rows before t0 on the way: one-row probes, doubling
 * from the first row until past t0 (or the end), then halving to within
 * `limit`. About 2 log2(rows / limit) probes, once per cursor (Tail).
 */
export async function seekAfter<R extends TailRow>(page: PageFn<R>, t0: number, limit: number): Promise<number> {
  const first = await page(0, 1);
  if (first.length === 0 || first[0].t >= t0) return 0;
  let lo = first[0].id; // every row up to lo is before t0
  let hi: number; // the row after hi is at or after t0, or there is none
  let step = limit;
  for (;;) {
    const x = lo + step;
    const r = await page(x, 1);
    if (r.length === 0 || r[0].t >= t0) {
      hi = x;
      break;
    }
    lo = r[0].id;
    step *= 2;
  }
  while (hi - lo > limit) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const r = await page(mid, 1);
    if (r.length === 0 || r[0].t >= t0) hi = mid;
    else lo = r[0].id;
  }
  return lo;
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

  private async run(page: PageFn<R>, now: number, epoch: number): Promise<void> {
    if (epoch !== this.epoch) {
      this.cursor = null;
      this.rows = [];
      this.epoch = epoch;
    }
    const t0 = now - this.windowMs;
    if (this.cursor === null) this.cursor = await seekAfter(page, t0, this.limit);
    this.complete = false;
    for (let n = 0; n < this.maxPages; n++) {
      const got = await page(this.cursor, this.limit);
      for (const r of got) if (r.t >= t0 && this.keep(r)) this.rows.push(r);
      if (got.length > 0) this.cursor = got[got.length - 1].id;
      if (got.length < this.limit) {
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
