import type { CoreStatus } from '@/core/types';
import type { Ctx } from '@/lib/ctx';

/** The core's status for the admin page, or null when the core can't be reached (the error is logged, never shown). */
export async function coreStatusOrNull(ctx: Ctx, actor: number): Promise<CoreStatus | null> {
  try {
    return await ctx.core.coreStatus(actor);
  } catch (e) {
    console.error('oc-portal: core status failed:', e);
    return null;
  }
}
