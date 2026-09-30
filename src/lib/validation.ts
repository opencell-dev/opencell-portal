import { z } from 'zod';

// Plain text: no control characters (tabs, newlines, NULs) and no invisible
// format characters (bidi overrides and isolates, zero-width spaces and
// joiners, soft hyphens) that could make a label read as something else.
const noControl = (s: string) => !/[\p{Cc}\p{Cf}]/u.test(s);
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;

/**
 * For a name that goes into mail and lists: plain text on one line, so no
 * Cc/Cf character and no Unicode line or paragraph separator. The one
 * exception is ZWNJ (U+200C) and ZWJ (U+200D) between two letters (a letter
 * and its marks before, a letter after): Persian and Indic names need them to
 * be spelled right. Anywhere else (at an edge, by a space or digit, doubled,
 * inside an emoji sequence) they stay refused.
 *
 * One pass over the code points (re-review F3): a regex lookbehind over
 * `\p{L}\p{M}*` went quadratic on long runs of marks.
 */
export function isOneLinePlain(s: string): boolean {
  const cps = Array.from(s);
  let afterLetter = false; // the last code point that wasn't a mark was a letter
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === '\u200C' || c === '\u200D') {
      if (!afterLetter || i + 1 === cps.length || !LETTER.test(cps[i + 1])) return false;
      afterLetter = false;
    } else if (FORBIDDEN.test(c)) {
      return false;
    } else if (LETTER.test(c)) {
      afterLetter = true;
    } else if (!MARK.test(c)) {
      afterLetter = false;
    }
  }
  return true;
}

// Every schema below that runs a regex or refinement over user input first
// caps the raw length and stops there (`abort`), then caps the trimmed value
// and stops there too: zod 4 otherwise still runs the later checks on an
// input that is already too long (re-review F3).

/**
 * The account's name (sign-up form). It reaches mail, the admin list and the
 * directory, so it is one line of visible plain text (final review I2).
 */
const NAME_TOO_LONG = 'Please use at most 80 characters for your name.';
export const nameSchema = z
  .string()
  .max(400, { error: NAME_TOO_LONG, abort: true })
  .trim()
  .min(1, { error: 'Please enter your name.', abort: true })
  .max(80, { error: NAME_TOO_LONG, abort: true })
  .refine(isOneLinePlain, 'Please use plain text for your name, on one line.');

const EMAIL_TOO_LONG = 'That email address is too long.';
export const emailSchema = z
  .string()
  .max(1024, { error: EMAIL_TOO_LONG, abort: true })
  .trim()
  .toLowerCase()
  .max(254, { error: EMAIL_TOO_LONG, abort: true })
  .pipe(z.email('Please enter a valid email address.'));

/** The first message of a failed parse, for showing next to the form. */
export function firstError(e: z.ZodError): string {
  return e.issues[0]?.message ?? 'Please check the form.';
}

/** A passkey's label, as the user typed it (spec §3 account page lists them by name). */
const PASSKEY_NAME_TOO_LONG = 'Please use at most 64 characters for the passkey name.';
export const passkeyNameSchema = z
  .string()
  .max(1024, { error: PASSKEY_NAME_TOO_LONG, abort: true })
  .trim()
  .min(1, { error: 'Please give the passkey a name.', abort: true })
  .max(64, { error: PASSKEY_NAME_TOO_LONG, abort: true })
  .refine(noControl, 'Please use plain text for the passkey name.');

/** The form's optional name: blank or missing becomes undefined, and the service names it "Passkey". */
export const optionalPasskeyNameSchema = z
  .string()
  .max(1024, { error: PASSKEY_NAME_TOO_LONG, abort: true })
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
