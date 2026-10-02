import type { CoreStatus } from '@/core/types';
import { askWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';

/** One core on the admin dashboard: its config id, where it listens, its status or null (unreachable). */
export interface CoreRow {
  id: string;
  where: string;
  status: CoreStatus | null;
}

/**
 * Every core's status for the admin dashboard, in config order, asked at
 * once (plan P4b). A core that is down or slow is null — "Unreachable" on
 * the page — and holds the page up by deadlineMs at most; the others show.
 */
export async function coreStatuses(ctx: Ctx, actor: number, deadlineMs = 3000): Promise<CoreRow[]> {
  return Promise.all(
    ctx.cores.map(async (h) => ({
      id: h.id,
      where: h.where,
      status: await askWithin(h, 'status', () => h.core.coreStatus(actor), deadlineMs),
    })),
  );
}
