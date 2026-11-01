import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@/config';
import { makeCores } from '@/core';
import { asFakeCore, FakeCore, HANG_MS } from '@/core/fake';
import { DEMO_SITES, hourWeight, prng, seedDemo } from '@/core/fake-demo';

afterEach(() => {
  vi.useRealTimers();
});

const base = { OC_ORIGIN: 'https://portal.test', OC_RP_ID: 'portal.test', OC_SECRET: 'x'.repeat(64) };
const NOW = 1_790_000_000_000;

describe('FakeCore for the NOC (NOC design §10)', () => {
  it('is known by its brand, not its class (one module copy per server bundle)', () => {
    const c = new FakeCore(() => NOW);
    expect(asFakeCore(c)).toBe(c);
    expect(asFakeCore({ coreId: 1, simReset: () => {} })).toBeNull(); // a look-alike without the brand
    expect(asFakeCore({ [Symbol.for('opencell.FakeCore')]: true })).not.toBeNull();
    expect(asFakeCore(null)).toBeNull();
    expect(asFakeCore('fake')).toBeNull();
  });

  it('plays the core it is told to be', async () => {
    const c = new FakeCore(() => NOW, { coreId: 2, name: 'oc-core-2', version: 'v9' });
    expect(await c.coreStatus(0)).toMatchObject({ coreId: 2, name: 'oc-core-2', version: 'v9' });
    expect(await new FakeCore(() => NOW).coreStatus(0)).toMatchObject({ coreId: 1, name: 'fake-core', version: '0.0.0-fake' });
  });

  it('counts calls in progress per cell and for the core, and drops them with the cell', async () => {
    const c = new FakeCore(() => NOW);
    const a = await c.cellAdd(0, 'A', 'part15', 1);
    const b = await c.cellAdd(0, 'B', 'part15', 1);
    c.simCellOnline(a, true);
    c.simCellOnline(b, true);
    c.simActiveCalls(a, 2);
    c.simActiveCalls(b, 1);
    expect((await c.cellStatus(0)).map((x) => x.calls)).toEqual([2, 1]);
    expect((await c.coreStatus(0)).callsNow).toBe(3);
    c.simCellOnline(a, false);
    await c.cellRevoke(0, b);
    expect((await c.coreStatus(0)).callsNow).toBe(0);
    expect(() => c.simActiveCalls(99, 1)).toThrow(/no cell 99/);
  });

  it('marks a cell offline since a given time', async () => {
    const c = new FakeCore(() => NOW);
    const a = await c.cellAdd(0, 'A', 'part15', 1);
    c.simCellOnline(a, true);
    c.simCellOffline(a, NOW - 600_000);
    expect((await c.cellStatus(0, a))[0]).toMatchObject({ online: false, lastHeardAt: NOW - 600_000 });
  });

  it('refuses every call while down, without auditing it, and answers again after', async () => {
    const c = new FakeCore(() => NOW);
    c.simDown('refuse');
    expect(c.isDown).toBe('refuse');
    await expect(c.coreStatus(0)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(c.numCheck(0, '+883171746412345')).rejects.toMatchObject({ code: 'unavailable' });
    expect(c.audit).toEqual([]);
    c.simDown(null);
    expect((await c.coreStatus(0)).name).toBe('fake-core');
  });

  it('hangs a call for HANG_MS, then fails it as the TLS client would', async () => {
    vi.useFakeTimers();
    const c = new FakeCore(() => NOW);
    c.simDown('hang');
    const p = c.cellStatus(0);
    const seen = expect(p).rejects.toMatchObject({ code: 'unavailable', message: 'the core did not answer in time (simulated)' });
    await vi.advanceTimersByTimeAsync(HANG_MS);
    await seen;
  });

  it('adds cells and activated, registered subscribers directly for the demo, with the same checks', async () => {
    const c = new FakeCore(() => NOW);
    const id = c.simAddCell('A', 'part97', 2, 'cd'.repeat(32));
    c.simSubscriber('+883171746412345', 0x76ad0488, id);
    expect((await c.cellStatus(0, id))[0]).toMatchObject({ certFpr: 'cd'.repeat(32), terminals: 1 });
    expect(await c.subStatus(0, '+883171746412345')).toMatchObject({ state: 'activated', registered: true, cellId: id, tmidPrefix: '76ad' });
    expect(() => c.simAddCell('B', 'part15', 1, 'nothex')).toThrow(/fingerprint/);
    expect(() => c.simSubscriber('+883171746412345', 1, null)).toThrow(/taken/);
    expect(() => c.simSubscriber('+883171746409911', 1, null)).toThrow(/not assignable/);
    expect(c.simCells()).toEqual([{ cellId: id, name: 'A', online: false, revoked: false }]);
    expect(c.audit.map((a) => a.op)).toEqual(['cell.status', 'sub.status']);
  });

  it('goes back to empty on simReset, its audit kept', async () => {
    const c = new FakeCore(() => NOW);
    seedDemo(c, 0, NOW);
    c.simDown('refuse');
    c.simReset();
    expect(c.isDown).toBeNull();
    expect(await c.cellStatus(0)).toEqual([]);
    expect(c.numbers()).toEqual([]);
    expect(c.audit.length).toBeGreaterThan(0);
    expect(await c.cellAdd(0, 'again', 'part15', 1)).toBe(1);
  });
});

describe('the demo network', () => {
  it('is the same every time for the same core', () => {
    const a = prng(7);
    const b = prng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(hourWeight(3)).toBeLessThan(hourWeight(18));
  });

  it("gives core index 0 the East site's cells in their states, with terminals on the online ones", async () => {
    const c = new FakeCore(() => NOW);
    const net = seedDemo(c, 0, NOW);
    const cells = await c.cellStatus(0);
    expect(cells.map((x) => x.name)).toEqual(DEMO_SITES[0].cells.map((x) => x.name));
    const by = Object.fromEntries(cells.map((x) => [x.name, x]));
    expect(by['Lancaster 1']).toMatchObject({ online: true, mode: 'part15', revoked: false });
    expect(by['Lancaster 2']).toMatchObject({ online: true, mode: 'part97', group: 2 });
    expect(by['Harrisburg 1']).toMatchObject({ online: false, lastHeardAt: NOW - 4 * 60_000, terminals: 0 });
    expect(by['Reading 1']).toMatchObject({ online: false, lastHeardAt: null, certFpr: null });
    expect(by['Lancaster 1'].terminals).toBeGreaterThanOrEqual(8);
    const st = await c.coreStatus(0);
    expect(st.subscribers).toBe(net.numbers.length);
    expect(st.cellsOnline).toBe(3);
    for (const n of net.numbers) expect(n.startsWith('+8831717464')).toBe(true);
  });

  it('gives each number about a week of calls, some to the echo service, all within the last 7 days', async () => {
    const c = new FakeCore(() => NOW);
    const net = seedDemo(c, 1, NOW);
    let total = 0;
    let echo = 0;
    for (const n of net.numbers) {
      const cdrs = await c.cdrList(0, n, 0);
      total += cdrs.length;
      echo += cdrs.filter((x) => x.peer === DEMO_SITES[1].echo).length;
      for (const x of cdrs) {
        expect(x.at).toBeLessThanOrEqual(NOW);
        expect(x.at).toBeGreaterThanOrEqual(NOW - 7 * 86400_000);
        if (x.result !== 'answered') expect(x.durationS).toBe(0);
      }
    }
    expect(total / net.numbers.length).toBeGreaterThan(5);
    expect(echo).toBeGreaterThan(0);
  });
});

describe('the fake cores from the configuration', () => {
  it('is one empty fake core by default, as before', async () => {
    const cores = makeCores(parseConfig(base));
    expect(cores.map((h) => [h.id, h.where])).toEqual([['fake', 'in-process']]);
    expect(await cores[0].core.cellStatus(0)).toEqual([]);
  });

  it('is several fake cores, each its own, with the demo network when asked', async () => {
    const cores = makeCores(parseConfig({ ...base, OC_FAKE_CORES: '2', OC_FAKE_DEMO: '1' }));
    expect(cores.map((h) => h.id)).toEqual(['fake', 'fake2']);
    const [s1, s2] = await Promise.all(cores.map((h) => h.core.coreStatus(0)));
    expect([s1.coreId, s1.name, s2.coreId, s2.name]).toEqual([1, 'fake-core', 2, 'fake-core-2']);
    expect(s1.cellsTotal).toBe(DEMO_SITES[0].cells.length);
    expect(s2.cellsTotal).toBe(DEMO_SITES[1].cells.length);
    expect(cores[1].core).toBeInstanceOf(FakeCore);
  });

  it('refuses the fake-core settings with the real core, and bad values', () => {
    const tls = { ...base, OC_CORE: 'tls', OC_CORE_ADDR: '10.0.0.60:7444', OC_CORE_CA: 'ca', OC_CORE_CERT: 'c', OC_CORE_KEY: 'k' };
    expect(() => parseConfig({ ...tls, OC_FAKE_DEMO: '1' })).toThrow(/OC_FAKE_DEMO is for the fake core only/);
    expect(() => parseConfig({ ...tls, OC_FAKE_CORES: '2' })).toThrow(/OC_FAKE_CORES is for the fake core only/);
    expect(() => parseConfig({ ...base, OC_FAKE_CORES: '5' })).toThrow(/OC_FAKE_CORES/);
    expect(() => parseConfig({ ...base, OC_FAKE_DEMO: 'yes' })).toThrow(/OC_FAKE_DEMO is 0 or 1/);
    expect(parseConfig(base).fake).toEqual({ cores: 1, demo: false });
  });
});

describe('the demo network: what the NOC telemetry shows (plan N2a)', () => {
  it("gives every online cell a radio report, York 1's in holdover with late slots, Salem 1's stale", async () => {
    const east = new FakeCore(() => NOW);
    seedDemo(east, 0, NOW);
    const radios = await east.cellRadio(0);
    const cells = await east.cellStatus(0);
    const name = (id: number) => cells.find((c) => c.cellId === id)?.name;
    expect(radios.map((x) => name(x.cellId))).toEqual(['Lancaster 1', 'Lancaster 2', 'York 1']);
    expect(radios.find((x) => name(x.cellId) === 'York 1')).toMatchObject({ pps: 'holdover', lateSlots: 140, radioErrors: 3 });
    for (const x of radios) expect(x.reportedAt).toBeGreaterThan(NOW - 60_000);
    const west = new FakeCore(() => NOW, { coreId: 2 });
    seedDemo(west, 1, NOW, 2);
    const salem = (await west.cellStatus(0)).find((c) => c.name === 'Salem 1')!;
    expect((await west.cellRadio(0, salem.cellId))[0].reportedAt).toBe(NOW - 6 * 60_000);
  });

  it('gives registrations their signal, most of them reported, and REGISTER records within the last day', async () => {
    const c = new FakeCore(() => NOW);
    const net = seedDemo(c, 0, NOW);
    const regs = await c.regList(0);
    expect(regs.map((r) => r.number).sort()).toEqual([...net.numbers].sort());
    const heard = regs.filter((r) => r.rssiDbm !== null);
    expect(heard.length / regs.length).toBeGreaterThan(0.7);
    for (const r of heard) {
      expect(r.rssiDbm).toBeLessThanOrEqual(-45);
      expect(r.rssiDbm).toBeGreaterThanOrEqual(-112);
    }
    const reg = await c.auditList(0, { events: [3], limit: 500 });
    expect(reg.length).toBeGreaterThanOrEqual(net.numbers.length);
    for (let i = 1; i < reg.length; i++) expect(reg[i].at).toBeGreaterThanOrEqual(reg[i - 1].at);
    for (const r of reg) expect(r.at).toBeGreaterThan(NOW - 86400_000);
  });

  it('records each call once, by end time, with its cells and legs; OCSS calls only with a second core', async () => {
    const c = new FakeCore(() => NOW);
    seedDemo(c, 0, NOW);
    const all = await c.cdrRecent(0, 0, 1000);
    expect(all.length).toBeGreaterThan(100);
    for (let i = 1; i < all.length; i++) expect(all[i].endAt).toBeGreaterThanOrEqual(all[i - 1].endAt);
    expect(all.every((x) => x.endAt <= NOW && x.setupAt <= x.endAt)).toBe(true);
    expect(all.filter((x) => x.legB === 'echo').every((x) => x.cellB === null && x.answerAt !== null)).toBe(true);
    expect(all.some((x) => x.legB === 'peer')).toBe(false);
    const two = new FakeCore(() => NOW);
    seedDemo(two, 0, NOW, 2);
    expect((await two.cdrRecent(0, 0, 1000)).some((x) => x.legB === 'peer' && x.called.startsWith('+8831503364'))).toBe(true);
  });

  it('peers neighbouring fake cores over OCSS (the lower id dials) and gives each its blocks', async () => {
    const c = new FakeCore(() => NOW, { coreId: 2 });
    seedDemo(c, 1, NOW, 3);
    expect((await c.ocssStatus(0)).map((p) => [p.coreId, p.dials, p.state])).toEqual([
      [1, false, 'up'],
      [3, true, 'connecting'],
    ]);
    expect(await c.coreBlocks(0)).toEqual([
      { index: 2, homeCore: 2, role: 'home', prefix: '8831503' },
      { index: 1, homeCore: 1, role: 'none', prefix: '8831717' },
      { index: 3, homeCore: 3, role: 'none', prefix: '8831208' },
    ]);
    const alone = new FakeCore(() => NOW);
    seedDemo(alone, 0, NOW);
    expect(await alone.ocssStatus(0)).toEqual([]);
  });
});
