import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreAdmin } from '@/core/types';

// What every CoreAdmin does alike (portal spec §7): the fake core and the
// real one over TLS pass the same tests, so what P2 and P3 build on the fake
// holds on oc-core. Each test uses numbers of its own: the core is shared.

export interface ContractCore {
  core: CoreAdmin;
  done: () => Promise<void>;
}

const EX = '+8831717464';
const H72 = 72 * 3600_000;

export function coreContract(name: string, make: () => Promise<ContractCore>) {
  describe(`the core admin API contract (${name})`, () => {
    let c: ContractCore;
    let seq = 0;
    const fresh = () => `${EX}${String(12000 + seq++).padStart(5, '0')}`;
    beforeAll(async () => {
      c = await make();
    }, 30_000);
    afterAll(async () => {
      await c?.done();
    });

    it('draws distinct free numbers in an exchange', async () => {
      const got = await c.core.numFree(7, EX, 8);
      expect(got).toHaveLength(8);
      expect(new Set(got).size).toBe(8);
      for (const n of got) {
        expect(n.startsWith(EX)).toBe(true);
        expect(await c.core.numCheck(7, n)).toBe('free');
      }
      const patterned = await c.core.numFree(7, EX, 4, '2xxx5');
      for (const n of patterned) expect(n).toMatch(/^\+88317174642\d{3}5$/);
    });

    it('refuses a bad exchange or count as invalid', async () => {
      await expect(c.core.numFree(7, '+8831717', 8)).rejects.toMatchObject({ code: 'invalid' });
      await expect(c.core.numFree(7, EX, 0)).rejects.toMatchObject({ code: 'invalid' });
      await expect(c.core.numFree(7, EX, 33)).rejects.toMatchObject({ code: 'invalid' });
    });

    it('says a reserved number or garbage is not assignable', async () => {
      expect(await c.core.numCheck(7, `${EX}09911`)).toBe('not_assignable');
      expect(await c.core.numCheck(7, 'garbage')).toBe('not_assignable');
    });

    it('creates a number with a 72 h code, once', async () => {
      const n = fresh();
      const t0 = Date.now();
      const tok = await c.core.subCreate(7, n);
      expect(tok.number).toBe(n);
      expect(tok.qr).toMatch(/^opencell:2:[A-Za-z0-9_-]{100}$/);
      expect(Math.abs(tok.expiresAt - (t0 + H72))).toBeLessThan(5000);
      expect(await c.core.numCheck(7, n)).toBe('taken');
      await expect(c.core.subCreate(8, n)).rejects.toMatchObject({ code: 'taken' });
      await expect(c.core.subCreate(8, `${EX}00911`)).rejects.toMatchObject({ code: 'not_assignable' });
    });

    it('shows an unactivated number, re-issues its code, and releases it', async () => {
      const n = fresh();
      const first = await c.core.subCreate(7, n);
      const st = await c.core.subStatus(7, n);
      expect(st).toMatchObject({
        number: n,
        state: 'unactivated',
        disabled: false,
        registered: false,
        cellId: null,
        tmidPrefix: null,
        lastSeenAt: null,
      });
      expect(Math.abs((st.tokenExpiresAt ?? 0) - first.expiresAt)).toBeLessThan(1000);
      const second = await c.core.subReissue(7, n);
      expect(second.qr).not.toBe(first.qr);
      await c.core.subRelease(7, n);
      await expect(c.core.subStatus(7, n)).rejects.toMatchObject({ code: 'not_found' });
      expect(await c.core.numCheck(7, n)).toBe('free');
      await c.core.subRelease(7, n); // free already: ok, a release is idempotent
      await expect(c.core.subReissue(7, n)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('disables and enables a number', async () => {
      const n = fresh();
      await c.core.subCreate(7, n);
      await c.core.subDisable(7, n);
      expect((await c.core.subStatus(7, n)).disabled).toBe(true);
      await c.core.subDisable(7, n); // again: no error
      await c.core.subEnable(7, n);
      expect((await c.core.subStatus(7, n)).disabled).toBe(false);
      await expect(c.core.subDisable(7, fresh())).rejects.toMatchObject({ code: 'not_found' });
    });

    it('lists no calls for a new number', async () => {
      const n = fresh();
      await c.core.subCreate(7, n);
      expect(await c.core.cdrList(7, n, 0)).toEqual([]);
    });

    it('adds a cell, pins its certificate, shows it and revokes it', async () => {
      const fpr = 'ab'.repeat(32);
      const id = await c.core.cellAdd(7, 'Lancaster 1', 'part97', 7);
      expect(id).toBeGreaterThan(0);
      await c.core.cellSetCert(7, id, fpr);
      const [cell] = await c.core.cellStatus(7, id);
      expect(cell).toMatchObject({
        cellId: id,
        name: 'Lancaster 1',
        mode: 'part97',
        group: 7,
        certFpr: fpr,
        revoked: false,
        online: false,
        terminals: 0,
        calls: 0,
      });
      await c.core.cellRevoke(7, id);
      const all = await c.core.cellStatus(7);
      expect(all.find((x) => x.cellId === id)).toMatchObject({ revoked: true, certFpr: null });
      await expect(c.core.cellStatus(7, 999_999)).rejects.toMatchObject({ code: 'not_found' });
      await expect(c.core.cellSetCert(7, id, 'nothex')).rejects.toMatchObject({ code: 'invalid' });
    });

    // ---- the NOC's operations (core v0.4.0, NOC design §7.1)

    it('reports no radios for a cell that is not linked, and not_found for no such cell', async () => {
      const id = await c.core.cellAdd(7, 'Radio test', 'part15', 1);
      expect(await c.core.cellRadio(7, id)).toEqual([]);
      expect((await c.core.cellRadio(7)).filter((r) => r.cellId === id)).toEqual([]);
      await expect(c.core.cellRadio(7, 999_999)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('lists registrations by number: none for numbers that never registered; refuses a bad cursor or cell', async () => {
      const n = fresh();
      await c.core.subCreate(7, n);
      expect((await c.core.regList(7)).map((r) => r.number)).not.toContain(n);
      expect(await c.core.regList(7, { after: '+883199999999998' })).toEqual([]);
      await expect(c.core.regList(7, { after: 'garbage' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(c.core.regList(7, { cellId: 999_999 })).rejects.toMatchObject({ code: 'not_found' });
    });

    it('lists call records after an id; refuses a limit out of 1-1000', async () => {
      const all = await c.core.cdrRecent(7, 0, 1000);
      for (let i = 1; i < all.length; i++) expect(all[i].id).toBeGreaterThan(all[i - 1].id);
      expect(await c.core.cdrRecent(7, 2 ** 31, 10)).toEqual([]);
      await expect(c.core.cdrRecent(7, 0, 0)).rejects.toMatchObject({ code: 'invalid' });
      await expect(c.core.cdrRecent(7, 0, 1001)).rejects.toMatchObject({ code: 'invalid' });
    });

    it("reads back its own audit: each call with its account, by number; refuses a limit out of 1-500", async () => {
      const n = fresh();
      await c.core.subCreate(31, n);
      const about = await c.core.auditList(7, { number: n, limit: 50 });
      const api = about.filter((r) => r.event === 11);
      expect(api.map((r) => r.detail)).toContainEqual(expect.stringMatching(/^a31 sub\.create ok/));
      expect(api.every((r) => r.number === n)).toBe(true);
      for (let i = 1; i < about.length; i++) expect(about[i].id).toBeGreaterThan(about[i - 1].id);
      const after = await c.core.auditList(7, { after: about[about.length - 1].id, number: n, limit: 50 });
      expect(after.map((r) => r.detail)).not.toContainEqual(expect.stringMatching(/^a31 sub\.create/));
      expect((await c.core.auditList(7, { events: [3], limit: 500 })).every((r) => r.event === 3)).toBe(true);
      await expect(c.core.auditList(7, { limit: 0 })).rejects.toMatchObject({ code: 'invalid' });
      await expect(c.core.auditList(7, { limit: 501 })).rejects.toMatchObject({ code: 'invalid' });
      await expect(c.core.auditList(7, { limit: 5, number: '+1717' })).rejects.toMatchObject({ code: 'invalid' });
    });

    it('has no OCSS peers when none is configured, and is home for its block', async () => {
      expect(await c.core.ocssStatus(7)).toEqual([]);
      expect(await c.core.coreBlocks(7)).toContainEqual({ index: 1, homeCore: 1, role: 'home', prefix: '8831717' });
    });

    it('switches a cell between Part 15 and Part 97, idempotently; refuses a revoked or unknown cell', async () => {
      const id = await c.core.cellAdd(7, 'Mode test', 'part15', 1);
      await c.core.cellMode(7, id, 'part97');
      expect((await c.core.cellStatus(7, id))[0].mode).toBe('part97');
      await c.core.cellMode(7, id, 'part97'); // already: ok, nothing changes
      expect((await c.core.cellStatus(7, id))[0].mode).toBe('part97');
      await c.core.cellMode(7, id, 'part15');
      expect((await c.core.cellStatus(7, id))[0].mode).toBe('part15');
      await expect(c.core.cellMode(7, 999_999, 'part97')).rejects.toMatchObject({ code: 'not_found' });
      await c.core.cellRevoke(7, id);
      await expect(c.core.cellMode(7, id, 'part97')).rejects.toMatchObject({ code: 'invalid' });
      expect((await c.core.cellStatus(7, id))[0].mode).toBe('part15');
    });

    it('reports its status', async () => {
      const st = await c.core.coreStatus(7);
      expect(st.coreId).toBe(1);
      expect(typeof st.name).toBe('string');
      expect(typeof st.version).toBe('string');
      expect(st.uptimeS).toBeGreaterThanOrEqual(0);
      expect(st.cellsTotal).toBeGreaterThanOrEqual(st.cellsOnline);
      expect(st.subscribers).toBeGreaterThanOrEqual(0);
    });
  });
}
