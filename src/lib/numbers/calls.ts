import type { Cdr } from '@/core/types';
import { askWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { coreActor } from '@/lib/site';
import { CORE_DEADLINE_MS, listNumbers } from './ownership';
import { coreFor } from './route';

// Calls (portal spec §5): the CDRs of the account's numbers, each from its
// number's home core (coreFor), for the last 90 days, newest first. A CDR is
// visible only to its number's holder (§10): the account's own numbers are
// the only ones asked about, and only since the account got each one.

export const CALLS_DAYS = 90;
export const CALLS_MAX = 1000;

export type AccountCall = Cdr & { mine: string };

/**
 * `filter`, when given, must be one of the account's numbers (anything else
 * gives nothing, and asks no core). `since` is unix ms, as CoreAdmin.cdrList
 * takes it (TlsCore sends seconds on the wire). A core that does not answer
 * in 3 s puts its numbers in `unavailable`.
 */
export async function accountCalls(ctx: Ctx, userId: number, filter?: string): Promise<{ calls: AccountCall[]; unavailable: string[] }> {
  const held = listNumbers(ctx, userId);
  const rows = filter === undefined ? held : held.filter((r) => r.number === filter);
  const floor = ctx.now() - CALLS_DAYS * 86400_000;
  const actor = coreActor(ctx.config.site, userId);
  const unavailable: string[] = [];
  const lists = await Promise.all(
    rows.map(async (r) => {
      const since = Math.max(floor, r.createdAt);
      const h = coreFor(ctx, r.number);
      const cdrs = await askWithin(h, 'cdr.list', () => h.core.cdrList(actor, r.number, since), CORE_DEADLINE_MS);
      if (cdrs === null) {
        unavailable.push(r.number);
        return [];
      }
      return cdrs.filter((c) => c.number === r.number && c.at >= since).map((c) => ({ ...c, mine: r.number }));
    }),
  );
  const calls = lists.flat().sort((a, b) => b.at - a.at || a.mine.localeCompare(b.mine));
  return { calls: calls.slice(0, CALLS_MAX), unavailable: unavailable.sort() };
}
