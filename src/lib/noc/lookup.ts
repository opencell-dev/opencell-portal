import { type Cdr, isCoreError, type SubStatus } from '@/core/types';
import { isFullNumber } from '@/core/numbers';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import { hit } from '@/lib/ratelimit';

// A staff number lookup (NOC design §9.5, §11): sub.status and the last
// 30 days of cdr.list for one number, from the core that holds numbers
// (core 1 until P5). Open to admins and NOC operators, unmasked (ruling
// 2026-10-01 #8/#9: an explicit override of portal spec §10). Each lookup is
// in the portal's audit, and each core call in the core's, under the same
// account id.

export const LOOKUP_DAYS = 30;
export const LOOKUP_CDRS = 100;

export type LookupResult =
  | { ok: true; number: string; core: string; status: SubStatus; cdrs: Cdr[]; more: boolean; since: number }
  | { ok: false; message: string };

/** A number as typed ("+883-1-717-464-12345", spaces, dots, brackets) in the full form, or null. */
export function normalizeNumber(s: string): string | null {
  const n = s.trim().replace(/[\s\-.()]/g, '');
  const full = n.startsWith('+') ? n : `+${n}`;
  return isFullNumber(full) ? full : null;
}

export async function lookupNumber(ctx: Ctx, actor: number, typed: string, ip: string): Promise<LookupResult> {
  const number = normalizeNumber(typed);
  if (!number) return { ok: false, message: 'That is not a full OpenCell number (+883 1 NPA NXX XXXXX).' };
  const lim = hit(ctx, 'noc_lookup', `user:${actor}`);
  if (!lim.ok) return { ok: false, message: lim.message };
  const h = ctx.cores[0];
  const since = ctx.now() - LOOKUP_DAYS * 86400_000;
  let found = false;
  try {
    const status = await h.core.subStatus(actor, number);
    found = true;
    const all = await h.core.cdrList(actor, number, since);
    const cdrs = all.slice().sort((a, b) => b.at - a.at);
    return { ok: true, number, core: h.id, status, cdrs: cdrs.slice(0, LOOKUP_CDRS), more: cdrs.length > LOOKUP_CDRS, since };
  } catch (e) {
    if (isCoreError(e) && e.code === 'not_found') return { ok: false, message: `No subscriber has ${number} on ${h.id}.` };
    if (isCoreError(e) && e.code === 'rate_limited') return { ok: false, message: `${h.id} is limiting these requests; try again in a minute.` };
    console.error(`oc-portal: lookup of ${number} on ${h.id} failed:`, e);
    return { ok: false, message: `${h.id} did not answer; try again.` };
  } finally {
    writeAudit(ctx, { actorId: actor, action: 'noc.lookup', target: `number:${number}`, detail: { core: h.id, found }, ip });
  }
}
