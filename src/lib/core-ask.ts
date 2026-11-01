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

/** What tryWithin learned: the answer, the core's error, or nothing in time. */
export type Asked<T> = { ok: true; value: T } | { ok: false; error: unknown } | { ok: false; late: true };

/**
 * askWithin for an operation whose refusal means something (portal P2: get a
 * number, where `taken` and `not_assignable` each have their own message):
 * the answer, the error it failed with, or `late` after deadlineMs. A late
 * answer still arrives, to `onLate`, so the caller can record what the core
 * did after all (a number it created while the page had given up). Failures
 * other than a plain refusal are logged, as askWithin does.
 */
export async function tryWithin<T>(
  h: CoreHandle,
  what: string,
  ask: () => Promise<T>,
  deadlineMs: number,
  onLate?: (r: { ok: true; value: T } | { ok: false; error: unknown }) => void,
): Promise<Asked<T>> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  const late = new Promise<Asked<T>>((resolve) => {
    timer = setTimeout(() => {
      console.error(`oc-portal: core ${h.id} (${h.where}) ${what}: no answer within ${deadlineMs} ms`);
      resolve({ ok: false, late: true });
    }, deadlineMs);
  });
  const asked = Promise.resolve()
    .then(ask)
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => {
        // A refusal that is an answer (taken, not_found) is not worth a log line; these are.
        if (!isCoreError(error) || error.code === 'unavailable' || error.code === 'rate_limited') console.error(`oc-portal: core ${h.id} (${h.where}) ${what} failed:`, error);
        return { ok: false as const, error };
      },
    )
    .then((r) => {
      if (settled) {
        try {
          onLate?.(r);
        } catch (e) {
          console.error(`oc-portal: core ${h.id} (${h.where}) ${what}: handling the late answer failed:`, e);
        }
      }
      return r;
    });
  try {
    return await Promise.race([asked, late]);
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}
