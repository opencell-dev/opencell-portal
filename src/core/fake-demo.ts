import type { FakeCore } from './fake';
import { isAssignable } from './numbers';
import type { Cdr, CellMode } from './types';

// The demo network (NOC design §10): what a fake core holds when the portal
// runs with OC_CORE=fake and OC_FAKE_DEMO=1, or after "Load the demo
// network" on /noc/demo. Deterministic: the same core index gives the same
// cells, numbers and calls, so screenshots and tests are repeatable.

/** mulberry32: a small seeded PRNG, enough for demo data (never for anything secret). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DemoCell {
  name: string;
  mode: CellMode;
  group: number;
  /** online, offline since `offlineMin` minutes ago, or never connected (no certificate either) */
  state: 'online' | 'offline' | 'never';
  offlineMin?: number;
}

interface DemoSite {
  exchange: string;
  /** The core's own echo service (network-core §22: +883 1 NPA 555 00100). */
  echo: string;
  /** Hours from UTC of the site's local time, for the diurnal traffic. */
  utcOffset: number;
  cells: DemoCell[];
}

/** One site per fake core index (East first, as core 1 is): the demo's cells and exchange. */
export const DEMO_SITES: DemoSite[] = [
  {
    exchange: '+8831717464',
    echo: '+883160655500100',
    utcOffset: -4,
    cells: [
      { name: 'Lancaster 1', mode: 'part15', group: 1, state: 'online' },
      { name: 'Lancaster 2', mode: 'part97', group: 2, state: 'online' },
      { name: 'York 1', mode: 'part15', group: 1, state: 'online' },
      { name: 'Harrisburg 1', mode: 'part15', group: 1, state: 'offline', offlineMin: 4 },
      { name: 'Reading 1', mode: 'part15', group: 1, state: 'never' },
    ],
  },
  {
    exchange: '+8831503364',
    echo: '+883150355500100',
    utcOffset: -7,
    cells: [
      { name: 'Portland 1', mode: 'part15', group: 1, state: 'online' },
      { name: 'Salem 1', mode: 'part97', group: 2, state: 'online' },
      { name: 'Eugene 1', mode: 'part15', group: 1, state: 'offline', offlineMin: 25 },
    ],
  },
  {
    exchange: '+8831208345',
    echo: '+883120855500100',
    utcOffset: -6,
    cells: [
      { name: 'Boise 1', mode: 'part15', group: 1, state: 'online' },
      { name: 'Nampa 1', mode: 'part15', group: 1, state: 'online' },
    ],
  },
  {
    exchange: '+8831406442',
    echo: '+883140655500100',
    utcOffset: -6,
    cells: [{ name: 'Missoula 1', mode: 'part97', group: 2, state: 'online' }],
  },
];

/** The share of a day's calls in each local hour: quiet at night, a peak in the early evening. */
export function hourWeight(localHour: number): number {
  const h = ((localHour % 24) + 24) % 24;
  return 0.1 + Math.max(0, Math.sin(((h - 6) / 15) * Math.PI)) * (h >= 17 && h <= 20 ? 1.4 : 1);
}

const RESULTS: [Cdr['result'], number][] = [
  ['answered', 0.78],
  ['no_answer', 0.1],
  ['busy', 0.05],
  ['unreachable', 0.05],
  ['failed', 0.02],
];

function pickResult(r: () => number): Cdr['result'] {
  let x = r();
  for (const [res, p] of RESULTS) {
    if (x < p) return res;
    x -= p;
  }
  return 'answered';
}

export interface DemoNetwork {
  cells: number[];
  numbers: string[];
}

/**
 * Seed `core` (empty, or emptied with simReset) as demo site `index`: its
 * cells, 8–16 registered terminals per online cell, calls in progress, and
 * 7 days of CDRs with a diurnal shape ending at `now`. Synchronous, through
 * the fake core's sim* helpers, so no call can see it half done.
 */
export function seedDemo(core: FakeCore, index: number, now: number): DemoNetwork {
  const site = DEMO_SITES[index % DEMO_SITES.length];
  const r = prng(0x0c0ffee + index);
  const out: DemoNetwork = { cells: [], numbers: [] };
  const online: number[] = [];
  for (const [i, c] of site.cells.entries()) {
    const fpr = c.state === 'never' ? null : (index * 16 + i + 1).toString(16).padStart(2, '0').repeat(32);
    const id = core.simAddCell(c.name, c.mode, c.group, fpr);
    out.cells.push(id);
    if (c.state === 'never') continue;
    core.simCellOnline(id, true);
    if (c.state === 'online') online.push(id);
  }
  let tmid = 0x76ad0000 + index * 0x1000;
  for (const cellId of online) {
    const n = 8 + Math.floor(r() * 9);
    for (let k = 0; k < n; k++) {
      let number: string;
      do number = site.exchange + String(1000 + Math.floor(r() * 98999)).padStart(5, '0');
      while (!isAssignable(number) || out.numbers.includes(number));
      core.simSubscriber(number, tmid++, cellId);
      out.numbers.push(number);
    }
    core.simActiveCalls(cellId, Math.floor(r() * 3));
  }
  // Seven days of calls: about two a day per number, shaped by the hour.
  const day = 86400_000;
  for (const number of out.numbers) {
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const start = Math.floor(now / 3600_000) * 3600_000 - (d * 24 + h) * 3600_000;
        const localHour = new Date(start + site.utcOffset * 3600_000).getUTCHours();
        if (r() > (2 * hourWeight(localHour)) / 14) continue;
        const at = start + Math.floor(r() * 3600_000);
        if (at > now || at < now - 7 * day) continue;
        const toEcho = r() < 0.15;
        const peer = toEcho ? site.echo : out.numbers[Math.floor(r() * out.numbers.length)];
        if (peer === number) continue;
        const result = toEcho ? 'answered' : pickResult(r);
        const durationS = result === 'answered' ? 10 + Math.floor(r() * 590) : 0;
        core.simCall({ at, number, peer, direction: 'out', durationS, result });
        if (!toEcho) core.simCall({ at, number: peer, peer: number, direction: 'in', durationS, result });
      }
    }
  }
  // Offline cells went quiet some minutes ago (simCellOnline stamps "now").
  for (const [i, c] of site.cells.entries()) {
    if (c.state === 'offline') core.simCellOffline(out.cells[i], now - (c.offlineMin ?? 5) * 60_000);
  }
  return out;
}
