import { and, asc, count, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { isAssignable } from '@/core/numbers';
import { type IssuedToken, isCoreError, type SubStatus } from '@/core/types';
import { numbers, users } from '@/db/schema';
import type { Result } from '@/lib/accounts';
import { writeAudit } from '@/lib/audit';
import { tryWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { hit, unhit } from '@/lib/ratelimit';
import type { RequestMeta, Session } from '@/lib/sessions';
import { coreActor } from '@/lib/site';
import { parseTyped } from './input';
import { blocksKnown } from './blocks';
import { whyNotOffered } from './places';
import { dropQr, putQr } from './qr-flash';
import { coreFor } from './route';

// Holding numbers (portal spec §4.1–4.2, §5 My numbers). The core holds the
// truth (who has a number, whether it is activated, when its token runs
// out); the `numbers` row is the portal's record of whose it is, plus the
// last status the core gave. A row is written only once the core answered
// sub.create, and removed once the core no longer has the number.

export type NumberRow = typeof numbers.$inferSelect;
type Who = Pick<Session, 'id' | 'userId'>;

/** At most 3 unactivated at once (spec §4.2: the same as the default limit, so nothing can be stockpiled). */
export const MAX_UNACTIVATED = 3;
/** Every number operation on a page gives up on the core after this (Review Focus: a plain message within 3 s). */
export const CORE_DEADLINE_MS = 3000;

export const NO_ANSWER = "The network didn't answer. Please try again in a minute.";
const MINE = 'You already have this number.';
const THEIRS = 'Someone just took that number. Pick another.';
const NOT_OPEN = "Numbers in this area code aren't open yet.";
const NO_SUCH = 'You have no such number.';
const ACTIVE = "This number is active on a terminal; it can't be released here.";

// Numbers a get is under way for, by number → account, until the core has
// answered (not merely until the page gave up at 3 s: a slow answer can still
// create the number). A double submit or a second tab is answered at once
// instead of racing the first to the core, and the caps count them.
// In-process is enough: the portal is one process (the PK on
// numbers.number is the backstop).
const g = globalThis as typeof globalThis & { __ocGetting?: Map<string, number> };
const getting = (): Map<string, number> => (g.__ocGetting ??= new Map());

/** Tests only: forget the gets under way (a hung core's answer outlives its test). */
export function forgetGetting(): void {
  getting().clear();
}

export function listNumbers(ctx: Ctx, userId: number): NumberRow[] {
  return ctx.db.select().from(numbers).where(eq(numbers.userId, userId)).orderBy(asc(numbers.createdAt), asc(numbers.number)).all();
}

export function numberOf(ctx: Ctx, userId: number, number: string): NumberRow | undefined {
  return ctx.db
    .select()
    .from(numbers)
    .where(and(eq(numbers.number, number), eq(numbers.userId, userId)))
    .get();
}

export interface Caps {
  held: number;
  unactivated: number;
  limit: number;
  canGet: boolean;
  why?: 'unactivated' | 'limit';
}

/** A row still waiting past its token: the core has released it, whether or not the portal has noticed yet. */
function ranOut(ctx: Ctx, r: NumberRow): boolean {
  return r.state === 'unactivated' && r.tokenExpiresAt !== null && r.tokenExpiresAt <= ctx.now();
}

/**
 * What an account may still get. "Unactivated" comes first: with 3 waiting,
 * a higher limit would not help, so the card asks for an activation, not a
 * reason (spec §4.2, §5). A number whose token ran out is free again at once
 * (Review Focus), sweep or no sweep: only the core's own clock decides it,
 * and the row goes at the next sync.
 */
export function capsOf(ctx: Ctx, userId: number): Caps {
  const rows = listNumbers(ctx, userId).filter((r) => !ranOut(ctx, r));
  const inFlight = [...getting().values()].filter((u) => u === userId).length;
  const held = rows.length + inFlight;
  const unactivated = rows.filter((r) => r.state === 'unactivated').length + inFlight;
  const limit = ctx.db.select({ l: users.numberLimit }).from(users).where(eq(users.id, userId)).get()?.l ?? 0;
  if (unactivated >= MAX_UNACTIVATED) return { held, unactivated, limit, canGet: false, why: 'unactivated' };
  if (held >= limit) return { held, unactivated, limit, canGet: false, why: 'limit' };
  return { held, unactivated, limit, canGet: true };
}

const getSchema = z.object({
  number: z.string().max(64),
  // The confirm step's checkbox: present ("on") when ticked, missing when not.
  listed: z.union([z.literal('on'), z.literal('1'), z.literal(true), z.undefined(), z.null(), z.literal('0'), z.literal(false)]),
});

export function coreMessage(e: unknown, fallback: string): string {
  if (!isCoreError(e)) return NO_ANSWER;
  if (e.code === 'not_assignable') return NOT_OPEN;
  if (e.code === 'rate_limited') return 'The network is busy right now. Please try again in a few minutes.';
  if (e.code === 'unavailable') return NO_ANSWER;
  return fallback;
}

/**
 * Get a number (spec §4.1 steps 3–4). In order: the input; assignable;
 * a real exchange offered for new numbers; this account's caps; the daily
 * limit; then sub.create on the number's home core within 3 s. Only then is
 * the row written and the QR put in this session's flash.
 */
export async function getNumber(ctx: Ctx, s: Who, input: { number: unknown; listed: unknown }, meta: RequestMeta): Promise<Result<{ token: IssuedToken }>> {
  const p = getSchema.safeParse(input);
  if (!p.success) return { ok: false, error: 'Please pick a number.' };
  const typed = parseTyped(p.data.number);
  if (typed.kind !== 'number') return { ok: false, error: typed.kind === 'bad' ? typed.message : 'Please type a whole number, like 717-464-12345.' };
  const number = typed.number;
  const listed = p.data.listed === 'on' || p.data.listed === '1' || p.data.listed === true;
  if (!isAssignable(number)) return { ok: false, error: 'That number cannot be given out: its last five digits must be 01000 to 99998 (and not 09911).' };
  const why = whyNotOffered(ctx, number.slice(0, 11));
  if (why) return { ok: false, error: why };

  const held = ctx.db.select().from(numbers).where(eq(numbers.number, number)).get();
  // A holder whose token ran out holds nothing at the core: ask, so the row
  // goes, instead of telling someone a free number was just taken.
  if (held && ranOut(ctx, held) && !getting().has(number)) {
    const after = await syncOne(ctx, held);
    if (after.failed) return { ok: false, error: NO_ANSWER };
    if (after.row) return { ok: false, error: held.userId === s.userId ? MINE : THEIRS };
  } else if (held) {
    return { ok: false, error: held.userId === s.userId ? MINE : THEIRS };
  }
  const flying = getting().get(number);
  if (flying !== undefined) return { ok: false, error: flying === s.userId ? MINE : THEIRS };
  const caps = capsOf(ctx, s.userId);
  if (caps.why === 'unactivated') return { ok: false, error: `You have ${caps.unactivated} numbers waiting for activation. Activate or release one first.` };
  if (caps.why === 'limit') return { ok: false, error: `You hold ${caps.held} numbers, your account's limit. Ask for more on My numbers.` };
  const lim = hit(ctx, 'number_account', String(s.userId));
  if (!lim.ok) return { ok: false, error: lim.message };

  const h = coreFor(ctx, number);
  const actor = coreActor(ctx.config.site, s.userId);
  const record = (token: IssuedToken, late: boolean) => {
    const now = ctx.now();
    ctx.db
      .insert(numbers)
      .values({ number, userId: s.userId, coreId: h.id, listed, createdAt: now, state: 'unactivated', tokenExpiresAt: token.expiresAt, statusAt: now })
      .run();
    putQr(s.id, token, now);
    writeAudit(ctx, { actorId: s.userId, action: 'number.get', target: `number:${number}`, detail: { core: h.id, listed, ...(late ? { late } : {}) }, ip: meta.ip });
  };
  // The client gave up (TlsCore's 5 s) or the connection dropped with the
  // request out: the core may have created the number, and only that answer
  // had its token. Nobody can ever activate it, so it goes back now rather
  // than sit taken for 72 h, unless someone holds it here by then.
  const lost = (error: unknown) => {
    if (!isCoreError(error) || error.code !== 'unavailable') return;
    if (getting().has(number) || ctx.db.select().from(numbers).where(eq(numbers.number, number)).get()) return;
    void tryWithin(h, 'sub.release', () => h.core.subRelease(actor, number), CORE_DEADLINE_MS).then((b) => {
      if (b.ok) writeAudit(ctx, { actorId: s.userId, action: 'number.get_lost', target: `number:${number}`, detail: { core: h.id }, ip: meta.ip });
    });
  };
  getting().set(number, s.userId);
  const asked = Promise.resolve()
    .then(() => h.core.subCreate(actor, number))
    .finally(() => getting().delete(number));
  const r = await tryWithin(h, 'sub.create', () => asked, CORE_DEADLINE_MS, (late) => {
    // The core created it after the page gave up: it is this account's
    // (it holds the token), so record it; it shows on My numbers.
    if (late.ok) record(late.value, true);
    else lost(late.error);
  });
  if (!r.ok) {
    if (!('late' in r)) lost(r.error);
    // The core never answered: that attempt must not count against the day's 10.
    if ('late' in r || (isCoreError(r.error) && r.error.code === 'unavailable')) unhit(ctx, 'number_account', String(s.userId));
    if ('late' in r) return { ok: false, error: NO_ANSWER };
    if (isCoreError(r.error) && r.error.code === 'taken') {
      const owner = ctx.db.select({ u: numbers.userId }).from(numbers).where(eq(numbers.number, number)).get()?.u;
      return { ok: false, error: owner === s.userId ? MINE : THEIRS };
    }
    return { ok: false, error: coreMessage(r.error, 'The network refused that number. Please pick another.') };
  }
  try {
    record(r.value, false);
  } catch (e) {
    // The PK refused a second row: someone holds it here already.
    console.error('oc-portal: getNumber: the number was issued but could not be recorded:', (e as Error).name);
    return { ok: false, error: THEIRS };
  }
  return { ok: true, token: r.value };
}

/**
 * A new QR for one of the account's numbers (spec §4.2): while unactivated,
 * a new token (the old one stops working); after activation, a move to a new
 * terminal (the old one is cut off, network-core §7.1).
 */
export async function reissueNumber(ctx: Ctx, s: Who, number: string, meta: RequestMeta): Promise<Result<{ token: IssuedToken }>> {
  const row = numberOf(ctx, s.userId, number);
  if (!row) return { ok: false, error: NO_SUCH };
  if (row.disabled) return { ok: false, error: 'This number is disabled. Write to opencell@k4ozi.com about it.' };
  const lim = hit(ctx, 'number_reissue', String(s.userId));
  if (!lim.ok) return { ok: false, error: lim.message };
  const h = coreFor(ctx, number);
  const r = await tryWithin(h, 'sub.reissue', () => h.core.subReissue(coreActor(ctx.config.site, s.userId), number), CORE_DEADLINE_MS);
  if (!r.ok) {
    if (!('late' in r) && isCoreError(r.error) && r.error.code === 'not_found') {
      await syncNumber(ctx, row);
      return { ok: false, error: 'This number went back to the pool: it was not activated within 3 days.' };
    }
    return { ok: false, error: 'late' in r ? NO_ANSWER : coreMessage(r.error, 'The network refused a new QR code for this number.') };
  }
  const now = ctx.now();
  if (row.state === 'unactivated') ctx.db.update(numbers).set({ tokenExpiresAt: r.value.expiresAt, statusAt: now }).where(eq(numbers.number, number)).run();
  putQr(s.id, r.value, now);
  writeAudit(ctx, { actorId: s.userId, action: 'number.reissue', target: `number:${number}`, detail: { state: row.state }, ip: meta.ip });
  return { ok: true, token: r.value };
}

/** Give back a number no terminal has activated yet (spec §5 "release"). */
export async function releaseNumber(ctx: Ctx, s: Who, number: string, meta: RequestMeta): Promise<Result> {
  const row = numberOf(ctx, s.userId, number);
  if (!row) return { ok: false, error: NO_SUCH };
  if (row.state !== 'unactivated') return { ok: false, error: ACTIVE };
  const h = coreFor(ctx, number);
  const r = await tryWithin(h, 'sub.release', () => h.core.subRelease(coreActor(ctx.config.site, s.userId), number), CORE_DEADLINE_MS);
  if (!r.ok) {
    if (!('late' in r) && isCoreError(r.error) && r.error.code === 'not_unactivated') {
      await syncNumber(ctx, row);
      return { ok: false, error: ACTIVE };
    }
    return { ok: false, error: 'late' in r ? NO_ANSWER : coreMessage(r.error, 'The network refused to release this number.') };
  }
  ctx.db.delete(numbers).where(eq(numbers.number, number)).run();
  dropQr(s.id, number);
  writeAudit(ctx, { actorId: s.userId, action: 'number.release', target: `number:${number}`, ip: meta.ip });
  return { ok: true };
}

function applyStatus(ctx: Ctx, row: NumberRow, st: SubStatus): NumberRow {
  const now = ctx.now();
  const set = {
    state: st.state,
    disabled: st.disabled,
    registered: st.registered,
    cellId: st.cellId,
    servingCore: st.servingCore,
    tmidPrefix: st.tmidPrefix,
    lastSeenAt: st.lastSeenAt,
    tokenExpiresAt: st.state === 'unactivated' ? st.tokenExpiresAt : null,
    // A different terminal than last seen is a move: it activated again.
    activatedAt: st.state !== 'activated' ? null : row.activatedAt === null || (row.tmidPrefix !== null && st.tmidPrefix !== row.tmidPrefix) ? now : row.activatedAt,
    statusAt: now,
  };
  ctx.db.update(numbers).set(set).where(eq(numbers.number, row.number)).run();
  return { ...row, ...set };
}

/**
 * Refresh one row from its core's sub.status. A number the core no longer
 * has while unactivated was released by the core's 72 h job (spec §4.2,
 * P2 decision 4): the row goes (audited number.expired) and null comes back.
 * The core down or late: the row as it was.
 */
export async function syncNumber(ctx: Ctx, row: NumberRow): Promise<NumberRow | null> {
  return (await syncOne(ctx, row)).row;
}

/** syncNumber, also saying whether the core failed to answer. */
async function syncOne(ctx: Ctx, row: NumberRow): Promise<{ row: NumberRow | null; failed: boolean; core: string }> {
  const h = coreFor(ctx, row.number);
  const r = await tryWithin(h, 'sub.status', () => h.core.subStatus(coreActor(ctx.config.site, row.userId), row.number), CORE_DEADLINE_MS);
  if (r.ok) return { row: applyStatus(ctx, row, r.value), failed: false, core: h.id };
  const notFound = !('late' in r) && isCoreError(r.error) && r.error.code === 'not_found';
  // Two cores and only the state rule to go by (no table yet): a table may
  // home this NPA elsewhere, so this core's not_found says nothing yet.
  if (notFound && ctx.cores.length > 1 && !blocksKnown(ctx)) return { row, failed: true, core: h.id };
  if (notFound && row.state === 'unactivated') {
    ctx.db.delete(numbers).where(and(eq(numbers.number, row.number), eq(numbers.userId, row.userId))).run();
    writeAudit(ctx, { actorId: null, action: 'number.expired', target: `number:${row.number}`, detail: { user: row.userId } });
    return { row: null, failed: false, core: h.id };
  }
  // An activated number the core does not know is not something the portal can fix: keep the card, say so in the log.
  if (notFound) console.error(`oc-portal: core ${h.id} has no subscriber for an activated number of account ${row.userId}`);
  // Asked, whatever came of it: sub.status is one bucket at the core for
  // everyone, so a core down or limiting is not asked more than once per 5 s.
  const statusAt = ctx.now();
  ctx.db.update(numbers).set({ statusAt }).where(eq(numbers.number, row.number)).run();
  return { row: { ...row, statusAt }, failed: !notFound, core: h.id };
}

/**
 * Sync an account's rows whose last ask is older than maxAgeMs, all at once,
 * each bounded by the 3 s deadline; the rows after it, and whether a core
 * failed to answer (which: `failedCores`, handle ids). P2 decision 3: at most
 * one sub.status per number per 5 s.
 */
export async function syncAccount(ctx: Ctx, userId: number, maxAgeMs = 5000): Promise<{ rows: NumberRow[]; unavailable: boolean; failedCores: Set<string> }> {
  const due = ctx.db
    .select()
    .from(numbers)
    .where(and(eq(numbers.userId, userId), or(isNull(numbers.statusAt), lt(numbers.statusAt, ctx.now() - maxAgeMs + 1))))
    .all();
  const after = await Promise.all(due.map((row) => syncOne(ctx, row)));
  const failedCores = new Set(after.filter((a) => a.failed).map((a) => a.core));
  return { rows: listNumbers(ctx, userId), unavailable: failedCores.size > 0, failedCores };
}

export async function syncDue(ctx: Ctx, userId: number, maxAgeMs = 5000): Promise<NumberRow[]> {
  return (await syncAccount(ctx, userId, maxAgeMs)).rows;
}

/**
 * Housekeeping (hourly): every number still waiting, longest unasked first,
 * so a release by the core or an activation shows here even if the owner
 * never looks (the caps, the directory, spec §4.2). One at a time, stopping
 * at the first failure: a sweep must not spend the bucket everyone's cards use.
 * Returns how many were released.
 */
export async function syncWaiting(ctx: Ctx, gapMs = 100, max = 1000): Promise<number> {
  const rows = ctx.db.select().from(numbers).where(eq(numbers.state, 'unactivated')).orderBy(asc(numbers.statusAt)).limit(max).all();
  let released = 0;
  for (const row of rows) {
    const r = await syncOne(ctx, row);
    if (r.failed) break;
    if (r.row === null) released++;
    if (gapMs > 0) await new Promise((res) => setTimeout(res, gapMs));
  }
  return released;
}

/** How many numbers an account holds (the admin's request review). */
export function heldCount(ctx: Ctx, userId: number): number {
  return ctx.db.select({ n: count() }).from(numbers).where(eq(numbers.userId, userId)).get()!.n;
}
