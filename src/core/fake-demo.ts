import type { FakeCore, FakeRadio } from './fake';
import { isAssignable } from './numbers';
import type { Cdr, CdrRecord, CellMode, CoreBlock, OcssPeer } from './types';

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
  /** What its radio reports, beside the usual (the NOC's radio scenarios): PPS in holdover, rising late slots, a stale report. */
  radio?: Partial<FakeRadio> & { staleMin?: number };
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
      { name: 'York 1', mode: 'part15', group: 1, state: 'online', radio: { pps: 'holdover', lateSlots: 140, radioErrors: 3, lastRadioError: -7 } },
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
      { name: 'Salem 1', mode: 'part97', group: 2, state: 'online', radio: { staleMin: 6 } },
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

/** What a demo call ended with, as the core records it: the oc_sig cause, the ring time and how long it lasted. */
const CAUSE: Record<Cdr['result'], number> = { answered: 0, busy: 2, no_answer: 3, unreachable: 4, failed: 5 };
const RING_S: Record<Cdr['result'], number> = { answered: 6, busy: 2, no_answer: 30, unreachable: 1, failed: 1 };

/** The block a demo site's core is home for: its exchange's first 7 digits (8831717), index = core id. */
export function demoBlocks(index: number, total: number): CoreBlock[] {
  const own = (i: number, role: CoreBlock['role']): CoreBlock => ({
    index: i + 1,
    homeCore: i + 1,
    role,
    prefix: DEMO_SITES[i % DEMO_SITES.length].exchange.slice(1, 8),
  });
  return [own(index, 'home'), ...Array.from({ length: total }, (_, i) => i).filter((i) => i !== index).map((i) => own(i, 'none'))];
}

/**
 * The demo's OCSS: each fake core peers with its neighbours (core ids are
 * index + 1; the lower id dials). With three or more cores, the link
 * between cores 2 and 3 is still connecting (the "OCSS link down" scenario).
 */
export function demoPeers(index: number, total: number, now: number): OcssPeer[] {
  return [index - 1, index + 1]
    .filter((j) => j >= 0 && j < total)
    .map((j) => {
      const dials = index < j;
      const down = Math.min(index, j) === 1 && Math.max(index, j) === 2;
      return {
        coreId: j + 1,
        dials,
        state: down ? 'connecting' : 'up',
        since: down ? now - 3 * 60_000 : now - 2 * 86400_000,
        lastRxAt: down ? null : now - 4000,
        lastTxAt: down ? null : now - 3000,
        calls: 0,
        dropped: 0,
        address: dials ? `10.99.0.${j + 1}:7443` : null,
      };
    });
}

/** An online demo cell's radio, from the site's PRNG and the cell's scenario. */
function demoRadio(r: () => number, c: DemoCell, terminals: number, now: number): FakeRadio {
  const uptimeS = 2 * 86400 + Math.floor(r() * 7 * 86400);
  const { staleMin, ...over } = c.radio ?? {};
  return {
    radio: 0,
    role: 'bs',
    band: c.mode === 'part97' ? 1 : 0,
    fw: '0.0.0',
    anchor: 10 + Math.floor(r() * 50),
    pps: 'locked',
    timebase: true,
    tempC: 35 + Math.floor(r() * 14),
    boardUptimeS: uptimeS,
    reportedAt: now - (staleMin !== undefined ? staleMin * 60_000 : Math.floor(r() * 50_000)),
    schedules: uptimeS * 10,
    rach: terminals * 20 + Math.floor(r() * 40),
    attach: terminals * 3,
    grants: terminals * 3,
    ackErrors: Math.floor(r() * 4),
    ackLate: Math.floor(r() * 2),
    lateSlots: Math.floor(r() * 3),
    radioErrors: 0,
    lastRadioError: 0,
    scheduleMisses: 0,
    uartCrcErrors: 0,
    terminalsHeard: terminals,
    ...over,
  };
}

/**
 * Seed `core` (empty, or emptied with simReset) as demo site `index`: its
 * cells, 8–16 registered terminals per online cell, calls in progress, and
 * 7 days of CDRs with a diurnal shape ending at `now`. Synchronous, through
 * the fake core's sim* helpers, so no call can see it half done.
 */
export function seedDemo(core: FakeCore, index: number, now: number, total = 1): DemoNetwork {
  const site = DEMO_SITES[index % DEMO_SITES.length];
  const r = prng(0x0c0ffee + index);
  // A second stream for what N2a added (radios, signal, registrations, call
  // timing), so the first gives the same cells, numbers and calls as before.
  const r2 = prng(0x5eed0000 + index);
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
  const cellOf = new Map<string, number>();
  const registrations: { at: number; number: string }[] = [];
  for (const cellId of online) {
    const n = 8 + Math.floor(r() * 9);
    for (let k = 0; k < n; k++) {
      let number: string;
      do number = site.exchange + String(1000 + Math.floor(r() * 98999)).padStart(5, '0');
      while (!isAssignable(number) || out.numbers.includes(number));
      core.simSubscriber(number, tmid++, cellId);
      out.numbers.push(number);
      cellOf.set(number, cellId);
      // 1-3 registrations in the last day; one in ten is not in its cell's latest report.
      const times = Array.from({ length: 1 + Math.floor(r2() * 3) }, () => now - Math.floor(r2() * 86400_000)).sort((a, b) => a - b);
      for (const at of times) registrations.push({ at, number });
      core.simSignal(
        number,
        r2() < 0.1 ? null : { rssiDbm: -45 - Math.floor(r2() * 68), snrDb: Math.round((r2() * 22 - 8) * 4) / 4, heardAt: now - Math.floor(r2() * 90_000) },
      );
    }
    core.simActiveCalls(cellId, Math.floor(r() * 3));
    const i = out.cells.indexOf(cellId);
    core.simRadio(cellId, [demoRadio(r2, site.cells[i], n, now)]);
  }
  // The core writes its audit as things happen: oldest first.
  registrations.sort((a, b) => a.at - b.at);
  for (const x of registrations) core.simRegisteredAt(x.number, x.at);
  // Seven days of calls: about two a day per number, shaped by the hour.
  const day = 86400_000;
  const calls: Omit<CdrRecord, 'id'>[] = [];
  const peerSite = total > 1 ? DEMO_SITES[(index + 1) % Math.min(total, DEMO_SITES.length)] : null;
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
        // One call in twenty goes to the next site's core over OCSS instead (two or more fake cores).
        const toPeer = !toEcho && peerSite !== null && r2() < 0.05;
        const called = toPeer ? `${peerSite.exchange}${String(10000 + Math.floor(r2() * 89999))}` : peer;
        const ring = (RING_S[result] + Math.floor(r2() * 6)) * 1000;
        const answerAt = result === 'answered' ? at + ring : null;
        const endAt = answerAt !== null ? answerAt + durationS * 1000 : at + ring;
        if (endAt > now) continue;
        calls.push({
          setupAt: at,
          answerAt,
          endAt,
          cause: CAUSE[result],
          caller: number,
          called,
          cellA: cellOf.get(number) ?? null,
          cellB: toEcho || toPeer ? null : (cellOf.get(peer) ?? null),
          legA: 'cell',
          legB: toEcho ? 'echo' : toPeer ? 'peer' : 'cell',
        });
      }
    }
  }
  // The core writes a CDR when its call ends: by end time.
  calls.sort((a, b) => a.endAt - b.endAt);
  for (const c of calls) core.simCdr(c);
  core.simBlocks(demoBlocks(index, total));
  core.simPeers(demoPeers(index, total, now));
  // Offline cells went quiet some minutes ago (simCellOnline stamps "now").
  for (const [i, c] of site.cells.entries()) {
    if (c.state === 'offline') core.simCellOffline(out.cells[i], now - (c.offlineMin ?? 5) * 60_000);
  }
  return out;
}
