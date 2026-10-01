import { beforeEach, describe, expect, it, vi } from 'vitest';
import { passkeys, users } from '@/db/schema';
import { createSession } from '@/lib/sessions';
import { grantRole } from '@/lib/users';
import { type TestCtx, testCtx } from '../helpers/ctx';

// NOC design §N1.5: the NOC's pages and its number lookup are on the NOC's
// own site only. The proxy already 404s /noc on the portal; requireNoc() is
// the check that holds when a NOC server action is posted to another page.

const state: { ctx?: TestCtx; token?: string } = {};
vi.mock('@/lib/ctx', () => ({ appCtx: () => state.ctx! }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === state.ctx!.config.sessionCookie && state.token ? { value: state.token } : undefined) }),
  headers: async () => new Headers(),
}));

const { requireNoc } = await import('@/server/request');

/** A NOC operator with a passkey, signed in with it (UV): what canUseNoc admits. */
function signedInOperator(ctx: TestCtx) {
  const id = ctx.db.insert(users).values({ name: 'Nia', email: 'nia@example.org', emailVerifiedAt: 1, createdAt: 1 }).returning().get().id;
  ctx.db.insert(passkeys).values({ id: 'cred-1', userId: id, publicKey: Buffer.from([1]), counter: 0, createdAt: 1 }).run();
  grantRole(ctx, id, 'noc', null);
  state.ctx = ctx;
  state.token = createSession(ctx, id, 'passkey', { ip: '192.0.2.1' }, { uv: true, credentialId: 'cred-1' }).token;
  return id;
}

beforeEach(() => {
  state.ctx = undefined;
  state.token = undefined;
});

describe('requireNoc', () => {
  it('admits staff on a UV passkey session on the NOC site', async () => {
    const id = signedInOperator(testCtx({ OC_SITE: 'noc' }));
    expect((await requireNoc()).user.id).toBe(id);
  });

  it('is a 404 on the subscriber portal, even for that same session', async () => {
    signedInOperator(testCtx());
    await expect(requireNoc()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });
});
