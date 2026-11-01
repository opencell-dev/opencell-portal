import type { IssuedToken } from '@/core/types';

// The activation QR is the one secret the core hands the portal (portal spec
// §7: "returns only the QR payload for a token it has just issued"), and the
// portal never stores it (§10). It lives here, in memory, for the session
// that asked for it, for 15 minutes: long enough to scan it, reload the page
// or email it to yourself; after that, "Show QR" is a re-issue (P2 decision 2).
// A restart forgets every flash, which is the same as the 15 minutes passing.

export const FLASH_MS = 15 * 60_000;
const PER_SESSION = 8;

export interface Entry {
  token: IssuedToken;
  at: number;
}

// On globalThis, not a module variable: Next's production build can load this
// module once per server bundle (the same reason as globalThis.__ocCores), and
// the action that puts a QR and the page that shows it must share one store.
const g = globalThis as typeof globalThis & { __ocQrFlash?: Map<string, Entry[]> };
const store = (): Map<string, Entry[]> => (g.__ocQrFlash ??= new Map());

function sweep(now: number): void {
  for (const [sid, list] of store()) {
    const live = list.filter((e) => now - e.at < FLASH_MS);
    if (live.length === 0) store().delete(sid);
    else if (live.length !== list.length) store().set(sid, live);
  }
}

/** Keep `t` for `sessionId` (a session's id: the hash of its cookie, never the cookie). A newer token for the same number replaces the older. */
export function putQr(sessionId: string, t: IssuedToken, now = Date.now()): void {
  sweep(now);
  const list = (store().get(sessionId) ?? []).filter((e) => e.token.number !== t.number);
  list.push({ token: t, at: now });
  store().set(sessionId, list.slice(-PER_SESSION));
}

/** The QR this session was given for `number`, while it is fresh; it stays for a reload (not deleted). */
export function takeQr(sessionId: string, number: string, now = Date.now()): IssuedToken | null {
  const e = store().get(sessionId)?.find((x) => x.token.number === number);
  return e && now - e.at < FLASH_MS ? e.token : null;
}

/** takeQr with the time it was put: a token issued before the number's activation was the one used up by it. */
export function flashOf(sessionId: string, number: string, now = Date.now()): Entry | null {
  const e = store().get(sessionId)?.find((x) => x.token.number === number);
  return e && now - e.at < FLASH_MS ? e : null;
}

/** Forget a number's QR (it was released). */
export function dropQr(sessionId: string, number: string): void {
  const list = store().get(sessionId);
  if (list) store().set(sessionId, list.filter((e) => e.token.number !== number));
}

/** Tests only: forget everything. */
export function clearQrFlash(): void {
  store().clear();
}
