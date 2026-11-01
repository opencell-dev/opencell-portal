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
 * Focus): nobody asks a core that just failed for cell names, and the lookup
 * after a sync gets what is left of the 3 s. A cell's name comes from the core
 * it is a cell of (OCSS spec §5.6): the serving core, or, when a v0.7.0 core
 * doesn't say, the number's home. No handle for it: the card says "cell <id>".
 */
export async function accountStatus(ctx: Ctx, userId: number): Promise<AccountStatus> {
  const t0 = Date.now();
  const { rows, unavailable, failedCores } = await syncAccount(ctx, userId);
  const cellCore = (r: NumberRow) => (r.servingCore === null ? coreFor(ctx, r.number).id : ctx.cores.find((h) => h.coreNo === r.servingCore)?.id);
  const cores = [...new Set(rows.filter((r) => r.registered && r.cellId !== null).flatMap((r) => cellCore(r) ?? []))];
  const left = () => Math.max(100, CORE_DEADLINE_MS - (Date.now() - t0));
  const names = new Map(await Promise.all(cores.map(async (id) => [id, failedCores.has(id) ? knownCellNames(id) : await cellNames(ctx, id, left())] as const)));
  const now = ctx.now();
  const numbers = rows.map((r) => {
    const core = cellCore(r);
    return {
      number: r.number,
      state: r.state,
      disabled: r.disabled,
      registered: r.registered,
      activatedAt: r.activatedAt,
      ...cardState(r, now, (id) => (core === undefined ? undefined : names.get(core)?.get(id))),
      tokenExpiresAt: r.tokenExpiresAt,
      terminal: r.tmidPrefix,
      lastSeenAt: r.lastSeenAt,
    };
  });
  return { numbers, unavailable };
}
