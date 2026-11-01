import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { STATE_CODE } from '@/core/state-codes';
import { credentialPath } from '@/core/tls-client';
import { type CoreBlock, type CoreHandle, isCoreError, type RouteStatus } from '@/core/types';
import { npas, routeAdditions } from '@/db/schema';
import { writeAudit } from '@/lib/audit';
import { tryWithin } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { errorKind } from '@/lib/errors';
import { sideOfStateCode } from './homing';

// The route delegate (OCSS spec §3.2, §3.5, §5.4; portal spec §8.2): an online
// Ed25519 key whose one power is to add new NPA blocks. The weekly refresh
// signs what core.blocks lacks and offers it to every core, keeping each
// addition so a core that is behind can be replayed. The key is read when a
// run needs it and is never logged, stored or put in a message: failures that
// touch it say only "no delegate key".

const BLOCKS_MAX = 16;
/** route.offer is 10/h, burst 2, at each core (OCSS spec §12 decision 22): a run offers each core at most this many. */
const OFFERS_PER_RUN = 2;
const ASK_MS = 10_000;
const DELEGATION_WARN_MS = 30 * 86400_000;
const PORTAL_ACTOR = 0;
const RAW_KEY_BYTES = 32;

export interface AdditionFields {
  rootVersion: number;
  seq: number;
  issued: number;
  delegate: Buffer;
  blocks: { npa: string; index: number; state: string }[];
}

/** The addition blob, byte for byte (OCSS spec §3.2). Throws on anything a core would call malformed. */
export function buildAddition(a: AdditionFields): Buffer {
  if (a.blocks.length < 1 || a.blocks.length > BLOCKS_MAX) throw new RangeError('an addition holds 1 to 16 blocks');
  if (a.delegate.length !== RAW_KEY_BYTES) throw new RangeError('a delegate key is 32 bytes');
  if (!Number.isInteger(a.seq) || a.seq < 1 || a.seq > 0xffff) throw new RangeError('seq out of range');
  const head = Buffer.alloc(15);
  head.write('OCRA', 0, 'latin1');
  head[4] = 1;
  head.writeUInt32LE(a.rootVersion, 5);
  head.writeUInt16LE(a.seq, 9);
  head.writeUInt32LE(a.issued, 11);
  const parts = [head, a.delegate, Buffer.from([a.blocks.length])];
  for (const b of a.blocks) {
    if (!/^[2-9]\d\d$/.test(b.npa) || b.npa.endsWith('11') || b.npa === '883') throw new RangeError(`not an NPA: ${b.npa}`);
    if (!STATE_CODE.test(b.state)) throw new RangeError(`not a state code: ${b.state}`);
    if (!Number.isInteger(b.index) || b.index < 1 || b.index > 0xffff) throw new RangeError(`index out of range: ${b.index}`);
    const row = Buffer.alloc(6);
    row.write(b.npa, 0, 'latin1');
    row.writeUInt16LE(b.index, 3);
    row[5] = b.state.length;
    parts.push(row, Buffer.from(b.state, 'latin1'));
  }
  return Buffer.concat(parts);
}

/** Pure Ed25519 over the whole blob (RFC 8032; OCSS spec §3.2). */
export function signAddition(blob: Buffer, keyPem: string): Buffer {
  return sign(null, blob, createPrivateKey(keyPem));
}

/** The raw 32-byte public key: an SPKI's last 32 bytes (OCSS spec §5.4). */
export function delegatePublicKey(keyPem: string): Buffer {
  const der = createPublicKey(createPrivateKey(keyPem)).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - RAW_KEY_BYTES);
}

/** The configured key file, or null. */
function readConfiguredKey(ctx: Ctx): string | null {
  const v = ctx.config.routeDelegateKey;
  return v === undefined ? null : readFileSync(credentialPath(v), 'utf8');
}

/** The key if it is here and is an Ed25519 private key, else null. Nothing about why: an error could quote it. */
function usableKey(read: () => string | null): string | null {
  try {
    const pem = read();
    return pem !== null && createPrivateKey(pem).asymmetricKeyType === 'ed25519' ? pem : null;
  } catch {
    return null;
  }
}

export interface OfferResult {
  /** The NPAs of new additions at least one core took. */
  offered: string[];
  /** How many held additions reached a core that lacked them. */
  replayed: number;
  /** Plain lines for the refresh log; never the key. */
  errors: string[];
}

type Addition = typeof routeAdditions.$inferSelect;

/** A core this run can work with, and how far it has got. */
interface CoreView {
  h: CoreHandle;
  status: RouteStatus;
  seq: number;
  offers: number;
}

const why = (r: { error: unknown } | { late: true }): string => {
  if ('late' in r) return 'no answer';
  return isCoreError(r.error) ? `${r.error.code}: ${r.error.message}` : errorKind(r.error);
};

/**
 * What the weekly refresh does for the routing table (OCSS spec §5.4):
 *
 * 1. route.status every core. One unreachable or unsigned, or on an older root
 *    table: an error, and nothing new this run.
 * 2. A core behind gets the additions it lacks, in order; those runs sign
 *    nothing new, so one seq never has two additions.
 * 3. All level: every geographic in-service NPA with a state code and no block
 *    in core.blocks (plan P5 decision 3: a failed week retries itself, and an
 *    NPA going into service later is caught) goes out in at most 2 additions of
 *    16, each stored before it is offered to every core.
 *
 * A core ahead of what the portal holds is an error, never overwritten; an
 * addition on another root version is ignored. A core's refusal is logged by
 * core and stops that chain for this run; the next run replays it.
 */
export async function offerMissingNpas(ctx: Ctx, opts: { readKey?: () => string | null } = {}): Promise<OfferResult> {
  const out: OfferResult = { offered: [], replayed: 0, errors: [] };
  const key = usableKey(opts.readKey ?? (() => readConfiguredKey(ctx)));
  if (key === null) out.errors.push('no delegate key');
  let mayAdd = key !== null;

  const asked = await Promise.all(
    ctx.cores.map(async (h) => ({ h, r: await tryWithin(h, 'route.status', () => h.core.routeStatus(PORTAL_ACTOR), ASK_MS) })),
  );
  const signedCores: CoreView[] = [];
  for (const { h, r } of asked) {
    if (!r.ok) {
      out.errors.push(`${h.id}: route.status: ${why(r)}`);
      mayAdd = false;
    } else if (!r.value.signed) {
      out.errors.push(`${h.id}: runs no signed table`);
      mayAdd = false;
    } else {
      signedCores.push({ h, status: r.value, seq: r.value.seq, offers: 0 });
    }
  }
  if (signedCores.length === 0) return out;

  // The newest root version is the chain: a core still on an older one is mid-deploy.
  const root = Math.max(...signedCores.map((v) => v.status.rootVersion));
  const on = signedCores.filter((v) => {
    if (v.status.rootVersion === root) return true;
    out.errors.push(`${v.h.id}: on root table ${v.status.rootVersion}, another core on ${root}`);
    mayAdd = false;
    return false;
  });

  const now = ctx.now();
  for (const v of on) {
    const end = v.status.delegateNotAfter;
    if (end === null || end <= now) {
      out.errors.push(`${v.h.id}: its table names no valid delegation`);
      mayAdd = false;
    }
  }
  const ends = on.flatMap((v) => (v.status.delegateNotAfter !== null && v.status.delegateNotAfter > now ? [v.status.delegateNotAfter] : []));
  if (ends.length > 0 && Math.min(...ends) - now < DELEGATION_WARN_MS) {
    out.errors.push(`the delegation ends ${new Date(Math.min(...ends)).toISOString().slice(0, 10)}: renew it with a new root version`);
  }

  const held = ctx.db.select().from(routeAdditions).where(eq(routeAdditions.rootVersion, root)).orderBy(asc(routeAdditions.seq)).all();
  const portalTop = held.at(-1)?.seq ?? 0;
  const coresTop = Math.max(...on.map((v) => v.seq));
  if (held.length > 0 && coresTop > portalTop) {
    for (const v of on.filter((x) => x.seq === coresTop)) out.errors.push(`${v.h.id}: at ${root}.${coresTop}, ahead of the portal (it holds up to ${root}.${portalTop})`);
    mayAdd = false;
  }

  /** Offer one addition to one core; whether it took it. */
  const offer = async (v: CoreView, a: Pick<Addition, 'seq' | 'blob' | 'sig'>): Promise<{ took: boolean; invalid: boolean }> => {
    v.offers++;
    const r = await tryWithin(v.h, 'route.offer', () => v.h.core.routeOffer(PORTAL_ACTOR, root, a.blob, a.sig), ASK_MS);
    if (r.ok) {
      v.seq = a.seq;
      return { took: true, invalid: false };
    }
    out.errors.push(`${v.h.id}: route.offer ${root}.${a.seq}: ${why(r)}`);
    return { took: false, invalid: !('late' in r) && isCoreError(r.error) && r.error.code === 'invalid' };
  };

  /** An addition no core took and every core refused outright can never be taken, so it must not block its seq (a wrong key, say). */
  const dropIfEveryCoreRefused = (seq: number, refused: number) => {
    if (refused !== ctx.cores.length || on.some((v) => v.seq >= seq)) return;
    ctx.db.delete(routeAdditions).where(and(eq(routeAdditions.rootVersion, root), eq(routeAdditions.seq, seq))).run();
    out.errors.push(`${root}.${seq}: every core refused it; not kept`);
  };

  // ---- a core behind: the additions it lacks, in order ----
  const top = Math.max(coresTop, portalTop);
  const refusedTop = { seq: 0, n: 0 };
  let behind = false;
  for (const v of on) {
    while (v.seq < top) {
      behind = true;
      if (v.offers >= OFFERS_PER_RUN) break;
      const a = held.find((x) => x.seq === v.seq + 1);
      if (!a) {
        out.errors.push(`${v.h.id}: at ${root}.${v.seq} and needs ${root}.${v.seq + 1}, which the portal does not hold`);
        mayAdd = false;
        break;
      }
      const r = await offer(v, a);
      if (!r.took) {
        if (r.invalid && a.seq === top) {
          refusedTop.seq = a.seq;
          refusedTop.n++;
        }
        break;
      }
      out.replayed++;
    }
  }
  if (behind) {
    dropIfEveryCoreRefused(refusedTop.seq, refusedTop.n);
    return out;
  }
  if (!mayAdd || key === null) return out;

  // ---- level: what is missing ----
  let blocks: CoreBlock[] | null = null;
  for (const v of on) {
    const r = await tryWithin(v.h, 'core.blocks', () => v.h.core.coreBlocks(PORTAL_ACTOR), ASK_MS);
    if (r.ok && r.value.length > 0) {
      blocks = r.value;
      break;
    }
  }
  if (blocks === null) {
    out.errors.push('core.blocks: no core answered');
    return out;
  }
  const have = new Set(blocks.map((b) => b.prefix));
  const rows = ctx.db
    .select({ npa: npas.npa, stateCode: npas.stateCode })
    .from(npas)
    .where(and(eq(npas.geographic, true), eq(npas.inService, true), isNotNull(npas.stateCode)))
    .orderBy(asc(npas.npa))
    .all();
  const missing: { npa: string; state: string }[] = [];
  for (const r of rows) {
    if (have.has(`8831${r.npa}`)) continue;
    // A code in neither list would refuse the whole addition (rule 7), and with it the NPAs beside it.
    if (sideOfStateCode(r.stateCode!) === null) out.errors.push(`npa ${r.npa}: state ${r.stateCode} is in neither list`);
    else missing.push({ npa: r.npa, state: r.stateCode! });
  }

  const delegate = delegatePublicKey(key);
  let seq = top;
  let index = Math.max(...on.map((v) => v.status.maxIdx));
  for (let i = 0; i < OFFERS_PER_RUN && i * BLOCKS_MAX < missing.length; i++) {
    const chunk = missing.slice(i * BLOCKS_MAX, (i + 1) * BLOCKS_MAX);
    seq++;
    let row: Pick<Addition, 'seq' | 'blob' | 'sig'>;
    try {
      const blob = buildAddition({ rootVersion: root, seq, issued: Math.floor(now / 1000), delegate, blocks: chunk.map((b) => ({ npa: b.npa, state: b.state, index: ++index })) });
      row = { seq, blob, sig: signAddition(blob, key) };
      ctx.db.insert(routeAdditions).values({ rootVersion: root, ...row, npas: JSON.stringify(chunk.map((b) => b.npa)), createdAt: now }).run();
    } catch (e) {
      out.errors.push(`${root}.${seq}: not signed (${errorKind(e)})`);
      return out;
    }
    writeAudit(ctx, { actorId: null, action: 'route.addition', target: `route:${root}.${seq}`, detail: { npas: chunk.map((b) => b.npa) } });
    const results = [];
    for (const v of on) results.push(await offer(v, row));
    if (results.some((r) => r.took)) out.offered.push(...chunk.map((b) => b.npa));
    if (results.every((r) => r.took)) continue;
    dropIfEveryCoreRefused(seq, results.filter((r) => r.invalid).length);
    return out;
  }
  return out;
}
