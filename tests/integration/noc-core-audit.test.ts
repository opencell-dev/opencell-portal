import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BlockTable, CoreAuditTable, OcssTable } from '@/components/noc/core-panels';
import { listAudit } from '@/lib/audit';
import { cachedActivity } from '@/lib/noc/activity';
import { CORRELATE_MS, correlate, coreAuditView, parseApiDetail, whoIs } from '@/lib/noc/core-audit';
import { lookupNumber } from '@/lib/noc/lookup';
import { cachedSnapshot } from '@/lib/noc/snapshot';
import { users } from '@/db/schema';
import { testCtx } from '../helpers/ctx';
import { AT } from '../helpers/noc-fixture';

// A core's own audit beside the portal's (plan N2a), matched by account and
// time (± 5 s): the admin API has no correlation id (decision #15).

describe('reading an API record', () => {
  it('parses "a<actor> <op> <status> [what]"', () => {
    expect(parseApiDetail('a1000042 cdr.list ok since 1790000000')).toEqual({ actor: 1_000_042, op: 'cdr.list', status: 'ok', what: 'since 1790000000' });
    expect(parseApiDetail('a0 core.status ok x5 in 60 s')).toEqual({ actor: 0, op: 'core.status', status: 'ok', what: 'x5 in 60 s' });
    expect(parseApiDetail('register')).toBeNull();
  });

  it("tells the NOC's polls, this site's accounts and the other site's apart, from either site", () => {
    expect(whoIs('noc', 0)).toEqual({ kind: 'polls' });
    expect(whoIs('noc', 1_000_042)).toEqual({ kind: 'this-site', userId: 42 });
    expect(whoIs('noc', 17)).toEqual({ kind: 'other-site', actor: 17 });
    expect(whoIs('portal', 17)).toEqual({ kind: 'this-site', userId: 17 });
    expect(whoIs('portal', 1_000_042)).toEqual({ kind: 'other-site', actor: 1_000_042 });
  });

  it("matches a core record to this site's rows of the same account within ± 5 s, and no others", () => {
    const rec = { id: 9, at: AT, event: 11, number: null, tmidPrefix: null, cellId: null, detail: 'a1000042 sub.status ok' };
    const row = (id: number, actorId: number, at: number) => ({ id, at, actorId, action: 'noc.lookup', target: null, detail: null, ip: null });
    const [c] = correlate([rec], [row(1, 42, AT - CORRELATE_MS), row(2, 42, AT + CORRELATE_MS + 1), row(3, 7, AT)], 'noc');
    expect(c.portal.map((p) => p.id)).toEqual([1]);
    expect(correlate([{ ...rec, event: 3, detail: 'register' }], [row(1, 42, AT)], 'noc')[0]).toMatchObject({ call: null, who: null, portal: [] });
  });
});

describe('coreAuditView', () => {
  it("shows a staff lookup in both audits, side by side, by the person's email; and audits the read", async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    const u = ctx.db.insert(users).values({ name: 'NOC Op', email: 'noc-op@example.test', emailVerifiedAt: 1, createdAt: 1 }).returning().get();
    ctx.core.simSubscriber('+883171746412345', 0x76ad0488, null);
    await cachedActivity(ctx, await cachedSnapshot(ctx)); // the audit's end, as of now
    await lookupNumber(ctx, u.id, '+883171746412345', '192.0.2.7');
    ctx.clock.t += 61_000;
    await cachedActivity(ctx, await cachedSnapshot(ctx));
    const spy = vi.spyOn(ctx.core, 'auditList');
    const v = await coreAuditView(ctx, 'fake', u.id, '192.0.2.7');
    expect(spy.mock.calls[0][0]).toBe(1_000_000 + u.id);
    if (v.records.state !== 'ok') throw new Error('no records');
    const status = v.records.value.find((c) => c.record.detail === `a${1_000_000 + u.id} sub.status ok`);
    expect(status?.portal.map((p) => p.action)).toEqual(['noc.lookup']);
    expect(v.emails[u.id]).toBe('noc-op@example.test');
    for (let i = 1; i < v.records.value.length; i++) expect(v.records.value[i].record.id).toBeLessThan(v.records.value[i - 1].record.id);
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: u.id, action: 'noc.core.audit', target: 'core:fake' });
    const out = renderToStaticMarkup(createElement(CoreAuditTable, { view: v }));
    expect(out).toMatch(/API.*sub\.status ok.*\+883-1-717-464-12345.*noc-op@example\.test.*noc\.lookup number:\+883171746412345/s);
    expect(out).toContain('the NOC itself (shared polls)');
  });

  it("says the core's audit is not read yet before the shared activity found its end", async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    const v = await coreAuditView(ctx, 'fake', 1, 'ip');
    expect(v.records.state).toBe('unreachable');
    expect(renderToStaticMarkup(createElement(CoreAuditTable, { view: v }))).toContain('not read yet');
  });

  it('says it is still catching up rather than showing a stale "newest first" while the shared audit tail has not read a whole day yet (review M2)', async () => {
    const ctx = testCtx({ OC_SITE: 'noc' });
    // More than one refresh's worth (8 pages of 500 = 4000) of audit records in the window.
    for (let i = 0; i < 4500; i++) {
      ctx.core.simAuditRecord({ at: ctx.now() - 1000, event: 11, number: null, tmidPrefix: null, cellId: null, detail: 'x' });
    }
    await cachedActivity(ctx, await cachedSnapshot(ctx)); // one refresh: not enough to read all of it
    const v = await coreAuditView(ctx, 'fake', 1, 'ip');
    expect(v.catchingUp).toBe(true);
    expect(renderToStaticMarkup(createElement(CoreAuditTable, { view: v }))).toContain('catching up');
  });
});

describe('the OCSS and block tables', () => {
  it('shows each peer with its state, who dials, last traffic, calls and bad frames', () => {
    const out = renderToStaticMarkup(
      createElement(OcssTable, {
        now: AT,
        ocss: {
          state: 'ok',
          value: [
            { coreId: 2, dials: true, state: 'up', since: AT - 86400_000, lastRxAt: AT - 4000, lastTxAt: AT - 3000, calls: 1, dropped: 3, address: '10.99.0.2:7443' },
            { coreId: 3, dials: false, state: 'connecting', since: AT - 180_000, lastRxAt: null, lastTxAt: null, calls: 0, dropped: 0, address: null },
          ],
        },
      }),
    );
    expect(out).toMatch(/core 2.*up.*1 d ago.*this core, to 10\.99\.0\.2:7443.*just now.*just now.*1.*3/s);
    expect(out).toMatch(/core 3.*connecting.*3 min ago.*the peer dials this core.*never/s);
    expect(renderToStaticMarkup(createElement(OcssTable, { now: AT, ocss: { state: 'ok', value: [] } }))).toContain('No OCSS peer is configured');
    expect(renderToStaticMarkup(createElement(OcssTable, { now: AT, ocss: { state: 'unsupported' } }))).toContain('needs oc-core v0.4.0');
  });

  it("shows the blocks, which are this core's and which route elsewhere", () => {
    const out = renderToStaticMarkup(
      createElement(BlockTable, {
        blocks: {
          state: 'ok',
          value: [
            { index: 1, homeCore: 1, role: 'home', prefix: '8831717' },
            { index: 2, homeCore: 2, role: 'none', prefix: '8831503' },
          ],
        },
      }),
    );
    expect(out).toMatch(/1.*\+8831717.*core 1.*home.*2.*\+8831503.*core 2.*routes to its home over OCSS/s);
  });
});
