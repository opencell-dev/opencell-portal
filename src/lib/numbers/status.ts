import type { Ctx } from '@/lib/ctx';
import { type CardState, cardState } from './card';
import { cellNames, knownCellNames } from './cells';
import { CORE_DEADLINE_MS, type NumberRow, syncAccount } from './ownership';
import { coreFor } from './route';

export interface NumberStatus extends CardState {
  number: string;
  state: NumberRow['state'];
  disabled: boolean;
  registered: boolean;
  activatedAt: number | null;
  tokenExpiresAt: number | null;
  /** The terminal: the first 2 bytes of its TMID, hex (spec §5 "the terminal id"). */
  terminal: string | null;
  lastSeenAt: number | null;
}

export interface AccountStatus {
  numbers: NumberStatus[];
  /** A core did not answer: the cards are as last seen, and the page says so. */
  unavailable: boolean;
}

/**
 * An account's numbers as the cards show them, after a sync (at most one
 * sub.status per number per 5 s). Within one 3 s deadline in all (Review
 * Focus): with a core that just failed nobody asks it for cell names, and the
 * lookup after a good sync gets what is left of the 3 s.
 */
export async function accountStatus(ctx: Ctx, userId: number): Promise<AccountStatus> {
  const t0 = Date.now();
  const { rows, unavailable } = await syncAccount(ctx, userId);
  const cores = [...new Set(rows.filter((r) => r.registered && r.cellId !== null).map((r) => coreFor(ctx, r.number).id))];
  const left = () => Math.max(100, CORE_DEADLINE_MS - (Date.now() - t0));
  const names = new Map(await Promise.all(cores.map(async (id) => [id, unavailable ? knownCellNames(id) : await cellNames(ctx, id, left())] as const)));
  const now = ctx.now();
  const numbers = rows.map((r) => ({
    number: r.number,
    state: r.state,
    disabled: r.disabled,
    registered: r.registered,
    activatedAt: r.activatedAt,
    ...cardState(r, now, (id) => names.get(coreFor(ctx, r.number).id)?.get(id)),
    tokenExpiresAt: r.tokenExpiresAt,
    terminal: r.tmidPrefix,
    lastSeenAt: r.lastSeenAt,
  }));
  return { numbers, unavailable };
}
