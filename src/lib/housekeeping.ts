import { purgeStale } from '@/lib/accounts';
import type { Ctx } from '@/lib/ctx';
import { errorKind } from '@/lib/errors';

export const HOUSEKEEPING_MS = 3600_000;

/**
 * Purge what has run out (purgeStale) now and then every `every` ms, so
 * unverified accounts and their sign-up IPs don't outlive their 7 days in a
 * quiet spell with no sign-ups (final review, minor 1). The timer never
 * keeps the process alive. A failure is logged by its class only: a
 * database error's message can quote the query's parameters (addresses).
 * Returns a function that stops it.
 */
export function startHousekeeping(ctx: Ctx, every = HOUSEKEEPING_MS): () => void {
  const run = () => {
    try {
      purgeStale(ctx);
    } catch (e) {
      console.error(`oc-portal: housekeeping purge failed (${errorKind(e)}); retrying in an hour`);
    }
  };
  run();
  const timer = setInterval(run, every);
  timer.unref();
  return () => clearInterval(timer);
}
