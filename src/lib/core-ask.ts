import { type CoreHandle, isCoreError } from '@/core/types';

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

/**
 * What a core said to one of the NOC's newer questions (core v0.4.0, NOC
 * design §7.2): the answer; 'unsupported', an older core that does not have
 * the operation (shown as "not reported by this core", never as an error);
 * or 'unreachable', no answer within the deadline, or a failure.
 */
export type Reported<T> = { state: 'ok'; value: T } | { state: 'unsupported' } | { state: 'unreachable' };

/**
 * As askWithin, but an older core's 'unsupported' is told apart from a
 * failure (and not logged as one). `onFailure`, when given, sees the raw
 * error for every failure that is not 'unsupported' (not a late answer),
 * so a caller can tell a rate limit apart from any other failure without
 * this function's external, 3-state contract growing a 4th state (I4).
 */
export async function askReported<T>(
  h: CoreHandle,
  what: string,
  ask: () => Promise<T>,
  deadlineMs: number,
  onFailure?: (e: unknown) => void,
): Promise<Reported<T>> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Reported<T>>((resolve) => {
    timer = setTimeout(() => {
      console.error(`oc-portal: core ${h.id} (${h.where}) ${what}: no answer within ${deadlineMs} ms`);
      resolve({ state: 'unreachable' });
    }, deadlineMs);
  });
  const asked = Promise.resolve()
    .then(ask)
    .then((value): Reported<T> => ({ state: 'ok', value }))
    .catch((e: unknown): Reported<T> => {
      if (isCoreError(e) && e.code === 'unsupported') return { state: 'unsupported' };
      onFailure?.(e);
      console.error(`oc-portal: core ${h.id} (${h.where}) ${what} failed:`, e);
      return { state: 'unreachable' };
    });
  try {
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
  }
}
