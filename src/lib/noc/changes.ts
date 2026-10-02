import { isCoreError } from '@/core/types';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import { errorKind } from '@/lib/errors';
import { hit } from '@/lib/ratelimit';
import { coreActor } from '@/lib/site';
import { groupNumber } from './format';

// The NOC's first changes to the network (plan N2a), each made under the
// staff member's own account (the core audits it with that account) and
// audited in the portal with its reason and outcome, so the two audits
// correlate by account and time. The actions (app/actions/admin-noc.ts)
// check the role and the fresh passkey first; these do the change.

export type ChangeResult = { ok: true; message: string } | { ok: false; message: string };

/** Stand-in for the core's error codes and anything else, in the portal audit. */
function outcomeOf(e: unknown): string {
  return isCoreError(e) ? e.code : errorKind(e);
}

/**
 * Disable or enable a subscriber on the core that holds numbers (core 1
 * until P5): sub.disable / sub.enable. A disabled terminal is deregistered
 * and can neither register nor call until enabled. Both are idempotent.
 */
export async function changeSubscriber(ctx: Ctx, userId: number, number: string, enable: boolean, reason: string, ip: string): Promise<ChangeResult> {
  const action = enable ? 'noc.sub.enable' : 'noc.sub.disable';
  const lim = hit(ctx, 'noc_change', `user:${userId}`);
  if (!lim.ok) {
    writeAudit(ctx, { actorId: userId, action: `${action}.limited`, target: `number:${number}`, detail: { reason }, ip });
    return { ok: false, message: lim.message };
  }
  const h = ctx.cores[0];
  const as = coreActor(ctx.config.site, userId);
  let outcome = 'ok';
  try {
    if (enable) await h.core.subEnable(as, number);
    else await h.core.subDisable(as, number);
  } catch (e) {
    outcome = outcomeOf(e);
  } finally {
    writeAudit(ctx, { actorId: userId, action, target: `number:${number}`, detail: { core: h.id, reason, outcome }, ip });
  }
  const n = groupNumber(number);
  if (outcome === 'ok') {
    return {
      ok: true,
      message: enable ? `${n} is enabled again on ${h.id}.` : `${n} is disabled on ${h.id}: it can't register or call until it is enabled.`,
    };
  }
  if (outcome === 'not_found') return { ok: false, message: `No subscriber has ${n} on ${h.id}.` };
  if (outcome === 'rate_limited') return { ok: false, message: `${h.id} is limiting these changes; try again in a few minutes.` };
  console.error(`oc-portal: ${action} on ${h.id} failed: ${outcome}`);
  return { ok: false, message: `${h.id} did not answer; look the number up again to see whether it changed.` };
}
