import { z } from 'zod';

// Plain text: no control characters (tabs, newlines, NULs) and no invisible
// format characters (bidi overrides and isolates, zero-width spaces and
// joiners, soft hyphens) that could make a label read as something else.
const noControl = (s: string) => !/[\p{Cc}\p{Cf}]/u.test(s);
// …and, for a name that goes into mail and lists, on one line: the Unicode
// line and paragraph separators too.
const oneLinePlain = (s: string) => noControl(s) && !/[\p{Zl}\p{Zp}]/u.test(s);

/**
 * The account's name (sign-up form). It reaches mail, the admin list and the
 * directory, so it is one line of visible plain text (final review I2).
 */
export const nameSchema = z
  .string()
  .trim()
  .min(1, 'Please enter your name.')
  .max(80, 'Please use at most 80 characters for your name.')
  .refine(oneLinePlain, 'Please use plain text for your name, on one line.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'That email address is too long.')
  .pipe(z.email('Please enter a valid email address.'));

/** The first message of a failed parse, for showing next to the form. */
export function firstError(e: z.ZodError): string {
  return e.issues[0]?.message ?? 'Please check the form.';
}

/** A passkey's label, as the user typed it (spec §3 account page lists them by name). */
export const passkeyNameSchema = z
  .string()
  .trim()
  .min(1, 'Please give the passkey a name.')
  .max(64, 'Please use at most 64 characters for the passkey name.')
  .refine(noControl, 'Please use plain text for the passkey name.');

/** The form's optional name: blank or missing becomes undefined, and the service names it "Passkey". */
export const optionalPasskeyNameSchema = z
  .string()
  .max(1024, 'Please use at most 64 characters for the passkey name.')
  .optional()
  .transform((s) => (s?.trim() ? s : undefined))
  .pipe(passkeyNameSchema.optional());

/** WebAuthn transports (L3 registry, plus the legacy "cable"). */
export const AUTHENTICATOR_TRANSPORTS = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const;
export type KnownTransport = (typeof AUTHENTICATOR_TRANSPORTS)[number];
const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set(AUTHENTICATOR_TRANSPORTS);

/**
 * The transports a browser reports for a new passkey: a short array of short
 * strings, or it is refused. They are only a hint for later ceremonies, so a
 * value this list doesn't know (a future transport) is dropped rather than
 * failing the registration; only known values, once each, are ever stored.
 */
export const passkeyTransportsSchema = z
  .array(z.string().max(32))
  .max(8)
  .transform((ts) => [...new Set(ts.filter((t): t is KnownTransport => KNOWN_TRANSPORTS.has(t)))]);
