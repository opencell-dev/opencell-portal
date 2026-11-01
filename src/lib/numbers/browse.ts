import type { NumCheck } from '@/core/types';
import { tryWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { hit } from '@/lib/ratelimit';
import { coreActor } from '@/lib/site';
import { CORE_DEADLINE_MS, coreMessage, NO_ANSWER } from './ownership';
import { coreFor } from './route';

// Looking at numbers (portal spec §4.1 steps 2 and 3): the shortlist's
// num.free and the confirm step's num.check, each limited per account first.
// A core's limits are one bucket per operation for the whole portal, so one
// account reloading a page must not starve the rest. The limit also bounds how
// fast an account can learn whether a number is held.

/** The shortlist's size (spec §4.1 step 2). */
export const SHORTLIST = 8;

const answer = (r: { ok: false; error: unknown } | { ok: false; late: true }) => ('late' in r ? NO_ANSWER : coreMessage(r.error, NO_ANSWER));

export async function drawFree(ctx: Ctx, userId: number, exchange: string): Promise<{ ok: true; numbers: string[] } | { ok: false; error: string }> {
  const lim = hit(ctx, 'number_browse', String(userId));
  if (!lim.ok) return { ok: false, error: lim.message };
  const h = coreFor(ctx, exchange);
  const r = await tryWithin(h, 'num.free', () => h.core.numFree(coreActor(ctx.config.site, userId), exchange, SHORTLIST), CORE_DEADLINE_MS);
  return r.ok ? { ok: true, numbers: r.value } : { ok: false, error: answer(r) };
}

export async function checkFree(ctx: Ctx, userId: number, number: string): Promise<{ ok: true; check: NumCheck } | { ok: false; error: string }> {
  const lim = hit(ctx, 'number_browse', String(userId));
  if (!lim.ok) return { ok: false, error: lim.message };
  const h = coreFor(ctx, number);
  const r = await tryWithin(h, 'num.check', () => h.core.numCheck(coreActor(ctx.config.site, userId), number), CORE_DEADLINE_MS);
  return r.ok ? { ok: true, check: r.value } : { ok: false, error: answer(r) };
}
