import type { CoreHandle } from '@/core/types';
import type { Ctx } from '@/lib/ctx';

/**
 * The core a number's operations go to: its block's home core. Every number
 * operation in the portal (get, re-issue, release, status, calls) asks this,
 * and nothing else picks a core, so P5 changes only this body.
 *
 * P2: every block lives on core 1 (portal spec §4.3, "until network-core
 * plan 10 lands"), so this is ctx.cores[0]. P5 replaces it with the NPA's
 * home core (sideOfNpa, homing.ts), falling back as the routing table says.
 */
export function coreFor(ctx: Ctx, _number: string): CoreHandle {
  return ctx.cores[0];
}
