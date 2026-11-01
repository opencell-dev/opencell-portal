// Small, framework-free helpers for the NOC's change forms (review final,
// v0.5.0-rc.1, M8): kept pure so SubscriberControls' control-flow bug is
// covered by a unit test, without a rendered component or a DOM.

/**
 * Run `refresh` after a change already succeeded, swallowing anything it
 * throws: the change itself is done, and a failed re-read must never be
 * mistaken for the change having failed.
 */
export async function afterChange(refresh: () => Promise<void>): Promise<void> {
  try {
    await refresh();
  } catch {
    // The change already happened; losing the re-read is not a reason to say otherwise.
  }
}

/**
 * `next` unless it is a failure (a refused or failed re-read): then keep
 * `previous`, so a transient refusal (for example the lookup's own rate
 * limit) does not hide what `previous` already showed -- including a
 * change's own success message, when `previous` and `next` are the same
 * lookup result the caller is about to display.
 */
export function keepOnFailure<T extends { ok: boolean }>(previous: T, next: T): T {
  return next.ok ? next : previous;
}
