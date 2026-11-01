import type { Ctx } from '@/lib/ctx';
import { type CardState, cardState } from './card';
import { cellNames } from './cells';
import { type NumberRow, syncDue } from './ownership';
import { coreFor } from './route';

export interface NumberStatus extends CardState {
  number: string;
  state: NumberRow['state'];
  tokenExpiresAt: number | null;
  /** The terminal: the first 2 bytes of its TMID, hex (spec §5 "the terminal id"). */
  terminal: string | null;
  lastSeenAt: number | null;
}

/** An account's numbers as the cards show them, after a sync (at most one sub.status per number per 5 s). */
export async function accountStatus(ctx: Ctx, userId: number): Promise<NumberStatus[]> {
  const rows = await syncDue(ctx, userId);
  const cores = [...new Set(rows.filter((r) => r.registered && r.cellId !== null).map((r) => coreFor(ctx, r.number).id))];
  const names = new Map(await Promise.all(cores.map(async (id) => [id, await cellNames(ctx, id)] as const)));
  const now = ctx.now();
  return rows.map((r) => ({
    number: r.number,
    state: r.state,
    ...cardState(r, now, (id) => names.get(coreFor(ctx, r.number).id)?.get(id)),
    tokenExpiresAt: r.tokenExpiresAt,
    terminal: r.tmidPrefix,
    lastSeenAt: r.lastSeenAt,
  }));
}
