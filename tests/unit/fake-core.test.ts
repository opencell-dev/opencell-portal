import { beforeEach, describe, expect, it } from 'vitest';
import { crc16CcittFalse, FakeCore } from '@/core/fake';
import { CoreError } from '@/core/types';

const H = 3600_000;
const EX = '+8831717464';
let t: number;
let core: FakeCore;

beforeEach(() => {
  t = 1_790_000_000_000;
  core = new FakeCore(() => t);
});

function decodeQr(qr: string) {
  expect(qr.startsWith('opencell:2:')).toBe(true);
  const b = Buffer.from(qr.slice('opencell:2:'.length), 'base64url');
  return b;
}

describe('FakeCore numbers', () => {
  it('draws distinct free, assignable numbers in an exchange', async () => {
    const got = await core.numFree(7, EX, 8);
    expect(got).toHaveLength(8);
    expect(new Set(got).size).toBe(8);
    for (const n of got) {
      expect(n.startsWith(EX)).toBe(true);
      expect(await core.numCheck(7, n)).toBe('free');
    }
  });

  it('matches a pattern of digits and x over the last five digits', async () => {
    const got = await core.numFree(7, EX, 5, '12xxx');
    expect(got).toHaveLength(5);
    for (const n of got) expect(n.slice(-5, -3)).toBe('12');
  });

  it('refuses a malformed exchange, count or pattern', async () => {
    await expect(core.numFree(7, '+8831717', 8)).rejects.toMatchObject({ code: 'invalid' });
    await expect(core.numFree(7, EX, 0)).rejects.toMatchObject({ code: 'invalid' });
    await expect(core.numFree(7, EX, 33)).rejects.toMatchObject({ code: 'invalid' });
    await expect(core.numFree(7, EX, 8, '12')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('checks vanity numbers', async () => {
    expect(await core.numCheck(7, '+883171746412345')).toBe('free');
    expect(await core.numCheck(7, '+883171746409911')).toBe('not_assignable');
    expect(await core.numCheck(7, 'garbage')).toBe('not_assignable');
    await core.subCreate(7, '+883171746412345');
    expect(await core.numCheck(7, '+883171746412345')).toBe('taken');
  });

  it('refuses an N11 NPA or NXX code', async () => {
    expect(await core.numCheck(7, '+883121146401234')).toBe('not_assignable'); // NPA 211
  });

  it('refuses NPA 883', async () => {
    expect(await core.numCheck(7, '+883188355512345')).toBe('not_assignable');
  });
});

describe('FakeCore subscribers', () => {
  it('creates a subscriber with a 72 h token and a v2 QR payload', async () => {
    const tok = await core.subCreate(7, '+883171746412345');
    expect(tok.expiresAt).toBe(t + 72 * H);
    expect(tok.qr).toHaveLength(111);
    const b = decodeQr(tok.qr);
    expect(b).toHaveLength(75);
    expect(b[0]).toBe(2);
    expect(b.subarray(59, 67).toString('hex')).toBe('883171746412345f');
    expect(b.readUInt32LE(67)).toBe(Math.floor((t + 72 * H) / 1000));
    expect(b.readUInt16LE(71)).toBe(0);
    expect(b.readUInt16LE(73)).toBe(crc16CcittFalse(b.subarray(0, 73)));
    const st = await core.subStatus(7, '+883171746412345');
    expect(st).toMatchObject({ state: 'unactivated', disabled: false, registered: false, tokenExpiresAt: t + 72 * H });
  });

  it('refuses a taken or unassignable number', async () => {
    await core.subCreate(7, '+883171746412345');
    await expect(core.subCreate(8, '+883171746412345')).rejects.toMatchObject({ code: 'taken' });
    await expect(core.subCreate(8, '+883171746400911')).rejects.toMatchObject({ code: 'not_assignable' });
  });

  it('re-issues a token (voiding the old one) and releases after 72 h unactivated', async () => {
    const first = await core.subCreate(7, '+883171746412345');
    t += 24 * H;
    const second = await core.subReissue(7, '+883171746412345');
    expect(second.qr).not.toBe(first.qr);
    expect(() => core.simActivate(first.qr, 0x01020304)).toThrow(CoreError);
    t += 72 * H - 1;
    expect((await core.subStatus(7, '+883171746412345')).state).toBe('unactivated');
    t += 1;
    await expect(core.subStatus(7, '+883171746412345')).rejects.toMatchObject({ code: 'not_found' });
    expect(core.audit.at(-1)).toMatchObject({ actor: 0, op: 'sub.release_expired', arg: '+883171746412345' });
  });

  it('activates, registers and records calls for a subscriber', async () => {
    const tok = await core.subCreate(7, '+883171746412345');
    core.simActivate(tok.qr, 0xa1b2c3d4);
    const cell = await core.cellAdd(1, 'Lancaster 1', 'part15', 1);
    core.simRegister('+883171746412345', cell);
    core.simCall({ number: '+883171746412345', peer: '+883160655500100', direction: 'out', durationS: 12, result: 'answered' });
    const st = await core.subStatus(7, '+883171746412345');
    expect(st).toMatchObject({ state: 'activated', registered: true, cellId: cell, tmidPrefix: 'a1b2', lastSeenAt: t, tokenExpiresAt: null });
    expect(await core.cdrList(7, '+883171746412345', 0)).toEqual([
      { at: t, number: '+883171746412345', peer: '+883160655500100', direction: 'out', durationS: 12, result: 'answered' },
    ]);
    expect(await core.cdrList(7, '+883171746412345', t + 1)).toEqual([]);
    // An activated number never expires, and cannot be released: only disabled.
    t += 100 * H;
    expect((await core.subStatus(7, '+883171746412345')).state).toBe('activated');
    await expect(core.subRelease(7, '+883171746412345')).rejects.toMatchObject({ code: 'not_unactivated' });
    await core.subDisable(1, '+883171746412345');
    expect((await core.subStatus(7, '+883171746412345')).disabled).toBe(true);
    await core.subEnable(1, '+883171746412345');
    expect((await core.subStatus(7, '+883171746412345')).disabled).toBe(false);
  });

  it('refuses an expired token at activation: the number was released with it', async () => {
    const tok = await core.subCreate(7, '+883171746412345');
    t += 72 * H;
    expect(() => core.simActivate(tok.qr, 1)).toThrow(/unknown or voided token/);
    expect(await core.numCheck(7, '+883171746412345')).toBe('free');
  });

  it('releases a number its code expiry freed already: ok, a release is idempotent', async () => {
    await core.subCreate(7, '+883171746412345');
    t += 72 * H;
    await core.subRelease(7, '+883171746412345');
    await core.subRelease(7, '+883171746412345');
    expect(await core.numCheck(7, '+883171746412345')).toBe('free');
  });

  it('releases an unactivated number on request', async () => {
    await core.subCreate(7, '+883171746412345');
    await core.subRelease(7, '+883171746412345');
    expect(await core.numCheck(7, '+883171746412345')).toBe('free');
  });

  it('writes every operation to its audit with the account id the portal passed', async () => {
    await core.numCheck(42, '+883171746412345');
    await core.subCreate(42, '+883171746412345');
    expect(core.audit.map((a) => [a.actor, a.op])).toEqual([
      [42, 'num.check'],
      [42, 'sub.create'],
    ]);
  });
});

describe('FakeCore cells and status', () => {
  it('adds, certifies, revokes and reports cells', async () => {
    const id = await core.cellAdd(1, 'Lancaster 1', 'part15', 3);
    await core.cellSetCert(1, id, 'ab'.repeat(32));
    core.simCellOnline(id, true);
    expect(await core.cellStatus(1, id)).toEqual([
      { cellId: id, name: 'Lancaster 1', mode: 'part15', group: 3, certFpr: 'ab'.repeat(32), revoked: false, online: true, lastHeardAt: t, terminals: 0, calls: 0 },
    ]);
    await core.cellRevoke(1, id);
    expect((await core.cellStatus(1))[0]).toMatchObject({ revoked: true, online: false, certFpr: null });
    await expect(core.cellSetCert(1, id, 'nothex')).rejects.toMatchObject({ code: 'invalid' });
    await expect(core.cellRevoke(1, 99)).rejects.toMatchObject({ code: 'not_found' });
    expect(await core.coreStatus(1)).toMatchObject({ cellsTotal: 1, cellsOnline: 0, subscribers: 0 });
  });

  it('accepts a route offer with a 64-byte signature', async () => {
    await core.routeOffer(0, 5, new Uint8Array([1, 2]), new Uint8Array(64));
    await expect(core.routeOffer(0, 5, new Uint8Array(0), new Uint8Array(64))).rejects.toMatchObject({ code: 'invalid' });
    expect(core.routes).toEqual([{ tableVersion: 5, size: 2 }]);
  });
});
