import type { CoreHandle } from '@/core/types';

/**
 * One question to one core, answered within deadlineMs or not at all:
 * the answer, or null when the core fails or is late (logged as
 * "core <id> (<where>) <what>: …", never shown). A late failure is still
 * logged. Shared by the admin dashboard (core-status.ts) and the NOC
 * (noc/snapshot.ts), so every view gives up on a core alike (plan P4b: 3 s).
 */
export async function askWithin<T>(h: CoreHandle, what: string, ask: () => Promise<T>, deadlineMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.error(`oc-portal: core ${h.id} (${h.where}) ${what}: no answer within ${deadlineMs} ms`);
      resolve(null);
    }, deadlineMs);
  });
  // Caught here, so a failure after the deadline is logged, not unhandled.
  // Wrapped in Promise.resolve().then(): a CoreAdmin method that throws
  // synchronously must still give null, not a rejection that skips the
  // deadline race and leaves the timer running (P4b review M3).
  const asked = Promise.resolve()
    .then(ask)
    .catch((e: unknown) => {
      console.error(`oc-portal: core ${h.id} (${h.where}) ${what} failed:`, e);
      return null;
    });
  try {
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
  }
}
