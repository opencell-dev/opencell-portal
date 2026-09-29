/**
 * An error whose message is written for the user (plain, and says nothing
 * about the server). Anything else that escapes a service is unexpected: its
 * message may carry internals, so it is logged here and never shown.
 */
export class UserError extends Error {
  override name = 'UserError';
}

/** What a server action may show for a caught error: a UserError's own message, or `fallback`. */
export function publicMessage(e: unknown, fallback: string): string {
  if (e instanceof UserError) return e.message;
  console.error('oc-portal: unexpected error in a server action:', e);
  return fallback;
}
