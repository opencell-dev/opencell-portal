import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeCore } from '@/core/fake';
import { CoreError, type CoreHandle } from '@/core/types';
import { askReported } from '@/lib/core-ask';
import { RADIO_STALE_MS, radioView } from '@/lib/noc/radio';
import { BLOCKS_TTL_MS, networkSnapshot, summarize, UNSUPPORTED_RETRY_MS } from '@/lib/noc/snapshot';
import { testCtx } from '../helpers/ctx';
import { AT, cell, fakeRadio, snap, st } from '../helpers/noc-fixture';

// Plan N2a: the shared snapshot also carries each core's radios (cell.radio),
// OCSS peers (ocss.status) and blocks (core.blocks), as the portal itself
// (actor 0), and tells an older core (no such operation) from a silent one.

afterEach(() => vi.restoreAllMocks());

function twoCores() {
  const ctx = testCtx();
  const core2 = new FakeCore(ctx.now, { coreId: 2 });
  const cores: CoreHandle[] = [ctx.cores[0], { id: 'core2', where: '10.99.0.2:7444', core: core2 }];
  return { ctx: { ...ctx, cores }, core1: ctx.core, core2 };
}

describe('askReported', () => {
  const h = (core: Partial<FakeCore>): CoreHandle => ({ id: 'c', where: 'x', core: core as FakeCore });

  it("tells an answer, an older core's 'unsupported' and a failure apart, logging only the failure", async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await askReported(h({}), 'x', async () => 5, 100)).toEqual({ state: 'ok', value: 5 });
    expect(await askReported(h({}), 'x', async () => Promise.reject(new CoreError('unsupported', 'no such operation')), 100)).toEqual({
      state: 'unsupported',
    });
    expect(err).not.toHaveBeenCalled();
    expect(await askReported(h({}), 'x', async () => Promise.reject(new CoreError('unavailable')), 100)).toEqual({ state: 'unreachable' });
    expect(await askReported(h({}), 'x', () => new Promise(() => {}), 20)).toEqual({ state: 'unreachable' });
    expect(err).toHaveBeenCalledTimes(2);
  });
});

describe('the snapshot with telemetry (plan N2a)', () => {
  it("carries each core's radios, OCSS peers and blocks, asked as the portal itself", async () => {
    const { ctx, core1, core2 } = twoCores();
    const id = core1.simAddCell('Lancaster 1', 'part15', 1);
    core1.simCellOnline(id, true);
    core1.simRadio(id, [fakeRadio()]);
    const peer = { coreId: 1, dials: false, state: 'up' as const, since: AT, lastRxAt: AT, lastTxAt: AT, calls: 0, dropped: 0, address: null };
    core2.simPeers([peer]);
    const radio = vi.spyOn(core1, 'cellRadio');
    const s = await networkSnapshot(ctx);
    expect(radio).toHaveBeenCalledWith(0);
    expect(s.cores[0].radio).toEqual({ state: 'ok', value: [{ ...fakeRadio(), cellId: id }] });
    expect(s.cores[1].ocss).toEqual({ state: 'ok', value: [peer] });
    expect(s.cores[1].blocks).toEqual({ state: 'ok', value: [{ index: 2, homeCore: 2, role: 'home', prefix: '8831717' }] });
  });

  it(`asks core.blocks once per ${BLOCKS_TTL_MS / 60_000} min, but again soon after a failure`, async () => {
    const { ctx, core2 } = twoCores();
    const blocks = vi.spyOn(core2, 'coreBlocks');
    await networkSnapshot(ctx);
    ctx.clock.t += 60_000;
    await networkSnapshot(ctx);
    expect(blocks).toHaveBeenCalledTimes(1);
    ctx.clock.t += BLOCKS_TTL_MS;
    blocks.mockRejectedValueOnce(new CoreError('unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await networkSnapshot(ctx)).cores[1].blocks).toEqual({ state: 'unreachable' });
    expect((await networkSnapshot(ctx)).cores[1].blocks?.state).toBe('ok');
    expect(blocks).toHaveBeenCalledTimes(3);
  });

  it(`shows an older core's missing operations as unsupported, and asks again only after ${UNSUPPORTED_RETRY_MS / 60_000} min`, async () => {
    const { ctx, core2 } = twoCores();
    const old = () => Promise.reject(new CoreError('unsupported', 'no such operation'));
    const radio = vi.spyOn(core2, 'cellRadio').mockImplementation(old);
    vi.spyOn(core2, 'ocssStatus').mockImplementation(old);
    const s = await networkSnapshot(ctx);
    expect(s.cores[1]).toMatchObject({ radio: { state: 'unsupported' }, ocss: { state: 'unsupported' } });
    expect(s.cores[1].status).not.toBeNull();
    ctx.clock.t += UNSUPPORTED_RETRY_MS - 1000;
    await networkSnapshot(ctx);
    expect(radio).toHaveBeenCalledTimes(1);
    ctx.clock.t += 2000;
    await networkSnapshot(ctx);
    expect(radio).toHaveBeenCalledTimes(2);
  });
});

describe('radioView', () => {
  const rs = (o: Parameters<typeof fakeRadio>[0] = {}) => ({ ...fakeRadio(o), cellId: 1 });
  it('reads a fresh report as it is', () => {
    expect(radioView(rs(), AT)).toEqual({ stale: false, boardSilent: false, pps: 'locked', timebase: true, tempC: 41, ageMs: 20_000 });
  });

  it('makes PPS, time and temperature unknown once the report is stale, or the board silent', () => {
    expect(radioView(rs({ reportedAt: AT - RADIO_STALE_MS - 1 }), AT)).toMatchObject({ stale: true, pps: 'unknown', timebase: null, tempC: null });
    expect(radioView(rs({ pps: 'unlocked', timebase: false, tempC: null }), AT)).toMatchObject({ boardSilent: true, pps: 'unknown' });
    expect(radioView(rs({ pps: 'unlocked', timebase: false, tempC: 30 }), AT)).toMatchObject({ boardSilent: false, pps: 'unlocked', timebase: false });
  });
});

describe('needs attention, from the telemetry (plan N2a)', () => {
  const withRadio = (radios: ReturnType<typeof fakeRadio>[], peers = [] as never[]) => ({
    ...snap,
    cores: [
      { ...snap.cores[0], radio: { state: 'ok' as const, value: radios.map((r) => ({ ...r, cellId: 1 })) }, ocss: { state: 'ok' as const, value: peers } },
      snap.cores[1],
    ],
  });
  const texts = (s: ReturnType<typeof withRadio>) => summarize(s).attention.map((a) => [a.severity, a.text]);

  it('says nothing about a healthy radio', () => {
    expect(texts(withRadio([fakeRadio({ radioErrors: 0 })])).filter(([, t]) => t.includes('Cell 1'))).toEqual([]);
  });

  it('warns of PPS in holdover, no timebase, a stale report or a silent board; tells of radio errors', () => {
    expect(texts(withRadio([fakeRadio({ pps: 'holdover', radioErrors: 3, lastRadioError: -7 })]))).toEqual(
      expect.arrayContaining([
        ['warning', 'Cell 1 "Lancaster 1" on core1: PPS holdover'],
        ['info', 'Cell 1 "Lancaster 1" on core1: 3 radio errors since the board started (last -7)'],
      ]),
    );
    expect(texts(withRadio([fakeRadio({ reportedAt: AT - 6 * 60_000 })]))).toContainEqual([
      'warning',
      'Cell 1 "Lancaster 1" on core1: last radio report 6 min ago; PPS and time unknown',
    ]);
    expect(texts(withRadio([fakeRadio({ pps: 'unlocked', timebase: false, tempC: null })]))).toContainEqual([
      'warning',
      'Cell 1 "Lancaster 1" on core1: the board is not answering the cell',
    ]);
    expect(texts(withRadio([]))).toContainEqual(['info', 'Cell 1 "Lancaster 1" on core1 has not reported its radio (oc-cell before v0.1.2, or just linked)']);
  });

  it('warns of an OCSS link that is not up', () => {
    const peer = { coreId: 2, dials: true, state: 'connecting', since: AT - 3 * 60_000, lastRxAt: null, lastTxAt: null, calls: 0, dropped: 0, address: 'x' };
    expect(texts(withRadio([fakeRadio()], [peer as never]))).toContainEqual(['warning', 'OCSS from core1 to core 2: connecting for 3 min']);
  });

  it('ignores telemetry it was not given (an N1 snapshot) and an older core', () => {
    expect(summarize(snap).attention.map((a) => a.text)).not.toContainEqual(expect.stringContaining('radio'));
    const old = { ...snap, cores: [{ ...snap.cores[0], status: st({}), cells: [cell({})], radio: { state: 'unsupported' as const } }] };
    expect(summarize(old).attention).toEqual([]);
  });
});
