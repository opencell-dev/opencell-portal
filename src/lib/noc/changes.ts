import type { CellMode } from '@/core/types';
import { isCoreError } from '@/core/types';
import { writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import { errorKind } from '@/lib/errors';
import { hit } from '@/lib/ratelimit';
import { coreActor } from '@/lib/site';
import { groupNumber, modeLabel } from './format';

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

/**
 * Switch a cell between Part 15 and Part 97 (cell.mode): the core stores the
 * mode and drops the cell's link; the cell reconnects in the new mode and
 * every call on it ends. Idempotent: already in that mode changes nothing.
 * `confirmName` must be the cell's name exactly, as the person typed it.
 */
export async function switchCellMode(
  ctx: Ctx,
  userId: number,
  core: string,
  cellId: number,
  mode: CellMode,
  confirmName: string,
  reason: string,
  ip: string,
): Promise<ChangeResult> {
  const h = ctx.cores.find((c) => c.id === core);
  if (!h) return { ok: false, message: `No core ${core}.` };
  const target = `cell:${core}/${cellId}`;
  // Review M5: the rate limit covers every attempt (including a wrong name), not only a completed change -- guessing a
  // cell's name is itself a change-shaped action and must not be unbounded.
  const lim = hit(ctx, 'noc_change', `user:${userId}`);
  if (!lim.ok) {
    writeAudit(ctx, { actorId: userId, action: 'noc.cell.mode.limited', target, detail: { reason }, ip });
    return { ok: false, message: lim.message };
  }
  const as = coreActor(ctx.config.site, userId);
  let cell: Awaited<ReturnType<typeof h.core.cellStatus>>[number] | undefined;
  try {
    [cell] = await h.core.cellStatus(as, cellId);
  } catch (e) {
    if (isCoreError(e) && e.code === 'not_found') return { ok: false, message: `No cell ${cellId} on ${core}.` };
    return { ok: false, message: `${core} did not answer; nothing was changed.` };
  }
  if (!cell) return { ok: false, message: `No cell ${cellId} on ${core}.` };
  // Review M5: a wrong name and a revoked cell leave no trace today; audit both, as every other refusal already is.
  if (confirmName !== cell.name) {
    writeAudit(ctx, { actorId: userId, action: 'noc.cell.mode', target, detail: { core, cell: cellId, outcome: 'wrong_name', reason }, ip });
    return { ok: false, message: `Type the cell's name exactly ("${cell.name}") to confirm; nothing was changed.` };
  }
  if (cell.revoked) {
    writeAudit(ctx, { actorId: userId, action: 'noc.cell.mode', target, detail: { core, cell: cellId, outcome: 'revoked', reason }, ip });
    return { ok: false, message: `Cell ${cellId} is revoked; its mode can't change.` };
  }
  const detail = { core, cell: cellId, from: cell.mode, to: mode, callsBefore: cell.calls, reason };
  if (cell.mode === mode) {
    writeAudit(ctx, { actorId: userId, action: 'noc.cell.mode', target, detail: { ...detail, outcome: 'unchanged' }, ip });
    return { ok: true, message: `${cell.name} is already ${modeLabel(mode)}; nothing was changed.` };
  }
  let outcome = 'ok';
  try {
    await h.core.cellMode(as, cellId, mode);
  } catch (e) {
    outcome = outcomeOf(e);
  } finally {
    writeAudit(ctx, { actorId: userId, action: 'noc.cell.mode', target, detail: { ...detail, outcome }, ip });
  }
  if (outcome === 'ok') {
    const ended = cell.calls === 0 ? 'no call was up' : `${cell.calls} ${cell.calls === 1 ? 'call' : 'calls'} ended`;
    return { ok: true, message: `${cell.name} is switching to ${modeLabel(mode)}: it reconnects in a few seconds; ${ended}.` };
  }
  if (outcome === 'invalid') return { ok: false, message: `${core} refused: cell ${cellId} is revoked.` };
  if (outcome === 'rate_limited') return { ok: false, message: `${core} is limiting mode switches; try again later.` };
  // Review M5: an older core (needs oc-core v0.4.0) is not the same as one that simply did not answer.
  if (outcome === 'unsupported') return { ok: false, message: `${core} does not support the mode switch yet (needs oc-core v0.4.0); nothing was changed.` };
  console.error(`oc-portal: noc.cell.mode on ${core} failed: ${outcome}`);
  return { ok: false, message: `${core} did not answer; check the cell's mode before trying again.` };
}
