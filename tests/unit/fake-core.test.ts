import { beforeEach, describe, expect, it } from 'vitest';
import { crc16CcittFalse, FakeCore } from '@/core/fake';
import { CoreError, type CoreBlock } from '@/core/types';
import { createPrivateKey, sign } from 'node:crypto';

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

});

// A delegate key of its own: the RFC 8032 vector's (OCSS spec §5.5), as PKCS#8.
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const KEY = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${SEED}`, 'hex'), format: 'der', type: 'pkcs8' });
const PUB = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');

/** An addition blob by hand (OCSS spec §3.2), separately from the portal's own builder: the fake checks it independently. */
function blobOf(root: number, seq: number, blocks: [string, number, string][]): Buffer {
  const head = Buffer.alloc(16);
  head.write('OCRA', 0, 'ascii');
  head[4] = 1;
  head.writeUInt32LE(root, 5);
  head.writeUInt16LE(seq, 9);
  head.writeUInt32LE(1793500000, 11);
  const parts = [head.subarray(0, 15), PUB, Buffer.from([blocks.length])];
  for (const [npa, idx, state] of blocks) {
    const b = Buffer.alloc(6);
    b.write(npa, 0, 'ascii');
    b.writeUInt16LE(idx, 3);
    b[5] = state.length;
    parts.push(b, Buffer.from(state, 'ascii'));
  }
  return Buffer.concat(parts);
}
const signed = (blob: Buffer) => sign(null, blob, KEY);

const BLOCKS: CoreBlock[] = [
  { index: 1, homeCore: 1, role: 'home', prefix: '8831606' },
  { index: 2, homeCore: 2, role: 'none', prefix: '8831503' },
];

describe('route.status and route.offer (OCSS spec §3.5, §5.1, §5.2)', () => {
  beforeEach(() => {
    core.simBlocks(BLOCKS, { signed: true, rootVersion: 7, seq: 0, maxIdx: 454, delegateNotAfter: t + 365 * 24 * H });
  });

  it('a config with block lines is unsigned, and takes no offer', async () => {
    const plain = new FakeCore(() => t);
    expect(await plain.routeStatus(0)).toEqual({ signed: false, rootVersion: 0, seq: 0, blocks: 1, maxIdx: 1, delegateNotAfter: null });
    const b = blobOf(0, 1, [['472', 2, 'US-NC']]);
    await expect(plain.routeOffer(0, 0, b, signed(b))).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('reports the signed table, counting its blocks; the index floor is the highest of max_idx and the blocks', async () => {
    expect(await core.routeStatus(0)).toEqual({ signed: true, rootVersion: 7, seq: 0, blocks: 2, maxIdx: 454, delegateNotAfter: t + 365 * 24 * H });
  });

  it('takes a good addition: the block is homed by its state, the other core secondary', async () => {
    const b = blobOf(7, 1, [['472', 455, 'US-NC'], ['206', 456, 'US-WA']]);
    expect(await core.routeOffer(0, 7, b, signed(b))).toEqual({ rootVersion: 7, seq: 1, blocks: 4, isNew: true });
    expect(await core.routeStatus(0)).toMatchObject({ seq: 1, blocks: 4, maxIdx: 456 });
    const got = await core.coreBlocks(0);
    expect(got).toContainEqual({ index: 455, homeCore: 1, role: 'home', prefix: '8831472' });
    expect(got).toContainEqual({ index: 456, homeCore: 2, role: 'secondary', prefix: '8831206' });
  });

  it('treats a byte-identical repeat as isNew: false, and changes nothing', async () => {
    const b = blobOf(7, 1, [['472', 455, 'US-NC']]);
    await core.routeOffer(0, 7, b, signed(b));
    expect(await core.routeOffer(0, 7, b, signed(b))).toEqual({ rootVersion: 7, seq: 1, blocks: 3, isNew: false });
    const forged = Buffer.from(signed(b));
    forged[0] ^= 1;
    await expect(core.routeOffer(0, 7, b, forged)).rejects.toMatchObject({ code: 'invalid', message: 'bad signature' });
  });

  it.each<[string, Buffer, number, string, string]>([
    ['bad magic', Buffer.concat([Buffer.from('OCRT'), blobOf(7, 1, [['472', 455, 'US-NC']]).subarray(4)]), 7, 'invalid', 'malformed'],
    ['a trailing byte', Buffer.concat([blobOf(7, 1, [['472', 455, 'US-NC']]), Buffer.from([0])]), 7, 'invalid', 'malformed'],
    ['no blocks', blobOf(7, 1, []), 7, 'invalid', 'malformed'],
    ['an NPA that is not one', blobOf(7, 1, [['411', 455, 'US-NC']]), 7, 'invalid', 'malformed'],
    ['a malformed state', blobOf(7, 1, [['472', 455, 'north']]), 7, 'invalid', 'malformed'],
    ['another root version', blobOf(8, 1, [['472', 455, 'US-NC']]), 8, 'invalid', 'root version 7 expected'],
    ['a request naming another root version', blobOf(7, 1, [['472', 455, 'US-NC']]), 8, 'invalid', 'root version 7 expected'],
    ['a gap in the seq', blobOf(7, 2, [['472', 455, 'US-NC']]), 7, 'invalid', 'out of order: at seq 0'],
    ['a used prefix', blobOf(7, 1, [['606', 455, 'US-KY']]), 7, 'invalid', 'rule: 606 is in the table'],
    ['the same prefix twice', blobOf(7, 1, [['472', 455, 'US-NC'], ['472', 456, 'US-NC']]), 7, 'invalid', 'rule: 472 is in the table'],
    ['a low index', blobOf(7, 1, [['472', 454, 'US-NC']]), 7, 'invalid', 'rule: index 454 is not above 454'],
    ['indexes that do not rise', blobOf(7, 1, [['472', 456, 'US-NC'], ['206', 455, 'US-WA']]), 7, 'invalid', 'rule: index 455 is not above 456'],
    ['a state in neither list', blobOf(7, 1, [['472', 455, 'US-ZZ']]), 7, 'invalid', 'rule: US-ZZ is in neither list'],
  ])('refuses %s', async (_what, blob, version, code, message) => {
    await expect(core.routeOffer(0, version, blob, signed(blob))).rejects.toMatchObject({ code, message });
    expect(await core.routeStatus(0)).toMatchObject({ seq: 0, blocks: 2 });
  });

  it('refuses a bad signature', async () => {
    const b = blobOf(7, 1, [['472', 455, 'US-NC']]);
    await expect(core.routeOffer(0, 7, b, Buffer.alloc(64))).rejects.toMatchObject({ code: 'invalid', message: 'bad signature' });
  });

  it('a different addition at a seq already held is taken', async () => {
    const a = blobOf(7, 1, [['472', 455, 'US-NC']]);
    await core.routeOffer(0, 7, a, signed(a));
    const other = blobOf(7, 1, [['206', 456, 'US-WA']]);
    await expect(core.routeOffer(0, 7, other, signed(other))).rejects.toMatchObject({ code: 'taken', message: 'seq 1 holds another addition' });
  });
});

describe("the serving core in sub.status (OCSS spec §5.6)", () => {
  it('follows simRegister: this core for its own cell, the other core for a visitor, null when not registered', async () => {
    const two = new FakeCore(() => t, { coreId: 2 });
    const n = `${EX}12345`;
    two.simActivate((await two.subCreate(0, n)).qr, 0x76ad0488);
    expect((await two.subStatus(0, n)).servingCore).toBeNull();
    const cell = two.simAddCell('Roof', 'part15', 1);
    two.simRegister(n, cell);
    expect(await two.subStatus(0, n)).toMatchObject({ cellId: cell, servingCore: 2 });
    two.simRegister(n, 3, 1);
    expect(await two.subStatus(0, n)).toMatchObject({ registered: true, cellId: 3, servingCore: 1 });
    expect(await two.regList(0)).toEqual([]); // a listing counts this core's own cells only
    two.simRegister(n, cell);
    expect(await two.subStatus(0, n)).toMatchObject({ cellId: cell, servingCore: 2 });
    expect(await two.regList(0)).toHaveLength(1);
  });
});
