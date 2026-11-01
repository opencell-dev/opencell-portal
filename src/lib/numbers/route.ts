import { type CoreAdmin, CoreError, type CoreHandle } from '@/core/types';
import type { Ctx } from '@/lib/ctx';
import { homeCoreOf } from './blocks';

/** A number's or an exchange's NPA (+8831NPA…), or null. */
export function npaOf(number: string): string | null {
  return /^\+8831([2-9]\d\d)/.exec(number)?.[1] ?? null;
}

/**
 * A handle for a core the portal can't reach by design: a home with no
 * handle here, or a number with no known home. Every call fails as a down
 * core's does, so callers' own paths say "the network didn't answer" and
 * nothing ever goes to a wrong core, which would answer "not home" or, worse,
 * issue the number there.
 */
export function unreachableHandle(id: string): CoreHandle {
  const core = new Proxy({} as CoreAdmin, {
    // Strings only, and not `then`: this must not read as a thenable, or as a FakeCore (a symbol brand).
    get: (_t, op) => (typeof op === 'string' && op !== 'then' ? () => Promise.reject(new CoreError('unavailable', `no core to ask for ${id}`)) : undefined),
  });
  return { id, where: 'not configured', coreNo: 0, core };
}

/**
 * The core a number's operations go to: its block's home core. Every number
 * operation in the portal (get, re-issue, release, status, calls, the NOC's
 * lookup) asks this, and nothing else picks a core. Never another core when
 * the home is down: the operation fails like any other with a core down.
 * One handle configured takes everything, even a West number (a single core,
 * the dev default).
 */
export function coreFor(ctx: Ctx, number: string): CoreHandle {
  if (ctx.cores.length === 1) return ctx.cores[0];
  const npa = npaOf(number);
  const home = npa === null ? null : homeCoreOf(ctx, npa);
  return ctx.cores.find((h) => h.coreNo === home) ?? unreachableHandle(home === null ? 'unknown' : `core${home}`);
}
