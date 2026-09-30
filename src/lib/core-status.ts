import type { CoreHandle, CoreStatus } from '@/core/types';
import type { Ctx } from '@/lib/ctx';

/** One core on the admin dashboard: its config id, where it listens, its status or null (unreachable). */
export interface CoreRow {
  id: string;
  where: string;
  status: CoreStatus | null;
}

/** A core's status, or null when it fails or has not answered within deadlineMs (logged, never shown). */
async function statusOf(h: CoreHandle, actor: number, deadlineMs: number): Promise<CoreStatus | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.error(`oc-portal: core ${h.id} (${h.where}) status: no answer within ${deadlineMs} ms`);
      resolve(null);
    }, deadlineMs);
  });
  // Caught here, so a failure after the deadline is logged, not unhandled.
  const asked = h.core.coreStatus(actor).catch((e: unknown) => {
    console.error(`oc-portal: core ${h.id} (${h.where}) status failed:`, e);
    return null;
  });
  try {
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every core's status for the admin dashboard, in config order, asked at
 * once (plan P4b). A core that is down or slow is null — "Unreachable" on
 * the page — and holds the page up by deadlineMs at most; the others show.
 */
export async function coreStatuses(ctx: Ctx, actor: number, deadlineMs = 3000): Promise<CoreRow[]> {
  return Promise.all(
    ctx.cores.map(async (h) => ({ id: h.id, where: h.where, status: await statusOf(h, actor, deadlineMs) })),
  );
}
