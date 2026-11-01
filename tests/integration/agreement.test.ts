import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agreementAcceptances, nodeRequests, users } from '@/db/schema';
import { acceptAgreement, acceptedVersion, agreementStats, needsAgreement, operatorsBehind, postSignInPath } from '@/lib/agreement';
import { grantRole } from '@/lib/users';
import { testCtx, type TestCtx } from '../helpers/ctx';

const version = vi.hoisted(() => ({ current: 1 }));
vi.mock('@/content/operator-agreement', async (orig) => ({
  ...(await orig<typeof import('@/content/operator-agreement')>()),
  get AGREEMENT_VERSION() {
    return version.current;
  },
}));

const META = { ip: '203.0.113.9' };

function user(ctx: TestCtx, email: string) {
  return ctx.db.insert(users).values({ name: email, email, emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
}

describe('the operator agreement log', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    version.current = 1;
    ctx = testCtx();
  });

  it('records an acceptance once, with version, time and address', () => {
    const u = user(ctx, 'a@example.org');
    acceptAgreement(ctx, u, 1, META);
    acceptAgreement(ctx, u, 1, META);
    const rows = ctx.db.select().from(agreementAcceptances).where(eq(agreementAcceptances.userId, u)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, acceptedAt: ctx.clock.t, ip: META.ip });
    expect(acceptedVersion(ctx, u)).toBe(1);
  });

  it('refuses a version that is not the current one', () => {
    expect(() => acceptAgreement(ctx, user(ctx, 'a@example.org'), 2, META)).toThrow();
  });

  it('asks an operator on an older version again at the next sign-in', () => {
    const u = user(ctx, 'a@example.org');
    grantRole(ctx, u, 'operator', null);
    acceptAgreement(ctx, u, 1, META);
    expect(needsAgreement(ctx, u)).toBe(false);
    expect(postSignInPath(ctx, u, '/numbers')).toBe('/numbers');
    version.current = 2;
    expect(needsAgreement(ctx, u)).toBe(true);
    expect(postSignInPath(ctx, u, '/numbers')).toBe('/nodes/agreement?next=%2Fnumbers');
    expect(operatorsBehind(ctx)).toEqual([expect.objectContaining({ userId: u, version: 1 })]);
    acceptAgreement(ctx, u, 2, META);
    expect(needsAgreement(ctx, u)).toBe(false);
    expect(agreementStats(ctx)).toEqual([
      { version: 2, accepted: 1 },
      { version: 1, accepted: 1 },
    ]);
  });

  it('asks a requester with an open request too, not one with a closed one', () => {
    const u = user(ctx, 'a@example.org');
    const id = ctx.db
      .insert(nodeRequests)
      .values({ userId: u, siteName: 'Roof', lat: 39, lon: -77, region: 'MD', piModel: 'pi5', w12Boards: 1, gps: false, antenna: 'Whip', backhaul: 'home', power: 'mains', contactPhone: '+13015550100', agreementVersion: 1, agreedAt: 1, status: 'pending', createdAt: 1 })
      .returning()
      .get().id;
    expect(needsAgreement(ctx, u)).toBe(true);
    ctx.db.update(nodeRequests).set({ status: 'declined' }).where(eq(nodeRequests.id, id)).run();
    expect(needsAgreement(ctx, u)).toBe(false);
  });

  it('leaves a plain subscriber alone', () => {
    const u = user(ctx, 'a@example.org');
    expect(needsAgreement(ctx, u)).toBe(false);
    expect(postSignInPath(ctx, u, '/numbers')).toBe('/numbers');
  });

  it.each(['https://evil.example/', '//evil.example/', '/\\evil.example', 'numbers', '/a\nb', ''])('keeps only same-origin paths: %j', (next) => {
    expect(postSignInPath(ctx, user(ctx, 'a@example.org'), next)).toBe('/numbers');
  });

  it('asks nothing on the NOC site, which has no nodes', () => {
    const noc = testCtx({ OC_SITE: 'noc' });
    const u = user(noc, 'a@example.org');
    grantRole(noc, u, 'operator', null);
    expect(needsAgreement(noc, u)).toBe(false);
    expect(postSignInPath(noc, u, '/noc')).toBe('/noc');
  });
});
