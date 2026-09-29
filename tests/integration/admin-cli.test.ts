import { beforeEach, describe, expect, it } from 'vitest';
import { users } from '@/db/schema';
import { runAdmin } from '@/lib/admin-cli';
import { listAudit } from '@/lib/audit';
import { limitOf } from '@/lib/ratelimit';
import { rolesOf } from '@/lib/users';
import { type TestCtx, testCtx } from '../helpers/ctx';

let ctx: TestCtx;
let ada: number;

beforeEach(() => {
  ctx = testCtx();
  ada = ctx.db.insert(users).values({ name: 'Ada', email: 'ada@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  ctx.db.insert(users).values({ name: 'Nov', email: 'new@example.org', createdAt: 2 }).run();
});

describe('oc-portal-admin', () => {
  it('promotes the first admin by email, and demotes', () => {
    expect(runAdmin(ctx, ['promote', 'ADA@example.org'])).toEqual({ code: 0, out: 'ada@example.org is now an admin' });
    expect(rolesOf(ctx, ada)).toEqual(['subscriber', 'admin']);
    expect(listAudit(ctx, 1)[0]).toMatchObject({ actorId: null, action: 'role.grant', target: `user:${ada}` });
    // A second admin so demoting Ada does not leave the portal with none.
    ctx.db.insert(users).values({ name: 'Bob', email: 'bob@example.org', emailVerifiedAt: 1, createdAt: 3 }).run();
    runAdmin(ctx, ['promote', 'bob@example.org']);
    expect(runAdmin(ctx, ['demote', 'ada@example.org'])).toEqual({ code: 0, out: 'ada@example.org is no longer an admin' });
    expect(rolesOf(ctx, ada)).toEqual(['subscriber']);
  });

  it('refuses to demote the last admin', () => {
    runAdmin(ctx, ['promote', 'ada@example.org']);
    expect(runAdmin(ctx, ['demote', 'ada@example.org'])).toEqual({ code: 1, out: 'Cannot remove the last admin.' });
    expect(rolesOf(ctx, ada)).toEqual(['subscriber', 'admin']);
  });

  it('refuses unknown or unverified accounts', () => {
    expect(runAdmin(ctx, ['promote', 'nobody@example.org'])).toEqual({ code: 1, out: 'no account with email nobody@example.org' });
    expect(runAdmin(ctx, ['promote', 'new@example.org'])).toEqual({
      code: 1,
      out: 'new@example.org has not verified its email yet; sign up and open the link first',
    });
  });

  it('lists users with their roles', () => {
    runAdmin(ctx, ['promote', 'ada@example.org']);
    expect(runAdmin(ctx, ['users']).out).toBe(
      ['id  email            verified  roles', `${ada}   ada@example.org  yes       subscriber,admin`, `${ada + 1}   new@example.org  no        -`].join('\n'),
    );
  });

  it('shows and sets rate limits', () => {
    expect(runAdmin(ctx, ['limit', 'set', 'magic_email', '10'])).toEqual({ code: 0, out: 'magic_email: 10 per 3600 s' });
    expect(limitOf(ctx, 'magic_email')).toEqual({ max: 10, windowS: 3600 });
    expect(runAdmin(ctx, ['limit', 'show']).out).toContain('magic_email: 10 per 3600 s');
    expect(runAdmin(ctx, ['limit', 'set', 'nope', '1']).code).toBe(2);
    expect(runAdmin(ctx, ['limit', 'set', 'magic_email', '0']).code).toBe(1);
  });

  it('prints usage for anything else', () => {
    expect(runAdmin(ctx, []).code).toBe(2);
    expect(runAdmin(ctx, ['frobnicate']).out).toMatch(/^usage: oc-portal-admin/);
  });
});
