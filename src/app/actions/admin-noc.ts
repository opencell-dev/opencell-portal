'use server';

import { z } from 'zod';
import { asFakeCore, type FakeCore, type FakeDown } from '@/core/fake';
import { seedDemo } from '@/core/fake-demo';
import { writeAudit } from '@/lib/audit';
import { appCtx } from '@/lib/ctx';
import { type LookupResult, lookupNumber } from '@/lib/noc/lookup';
import { forgetActivity } from '@/lib/noc/activity';
import { forgetSnapshot } from '@/lib/noc/snapshot';
import { requestMeta, requireAdmin, requireNoc } from '@/server/request';

export type DemoResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Staff (an admin or a NOC operator) looks up one number's status and
 * recent calls (NOC design §9.5; ruling 2026-10-01 #8/#9 opens this to NOC
 * operators too, unmasked, overriding portal spec §10): audited, rate-limited.
 */
export async function lookupNumberAction(number: string): Promise<LookupResult> {
  const { user } = await requireNoc();
  if (typeof number !== 'string' || number.length > 40) {
    // 2026-10-02: a live refusal here left no trace at all (no portal audit
    // row: lookupNumber() is never reached; no core call). Never the number
    // itself (it could be a real one, even malformed) — only its shape, so
    // a recurrence is at least visible in the journal.
    console.error(`oc-portal: lookupNumberAction: argument was ${typeof number}${Array.isArray(number) ? ' (array)' : ''}, not a string of at most 40 characters`);
    return { ok: false, message: 'That is not a full OpenCell number (+883 1 NPA NXX XXXXX).' };
  }
  return lookupNumber(appCtx(), user.id, number, (await requestMeta()).ip);
}

const demoSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('load') }),
  z.object({ op: z.literal('down'), core: z.string().max(16), mode: z.enum(['refuse', 'hang', 'none']) }),
  z.object({ op: z.literal('cell'), core: z.string().max(16), cellId: z.number().int().min(1), online: z.boolean() }),
]);

/**
 * The demo's controls (NOC design §10): reload the demo network, make a fake
 * core refuse or hang, take a fake cell off line or back. Admin only (N1's
 * ruling leaves demo controls out of the NOC operator's reach). Only with
 * the fake core; in-memory only; audited as demo.*.
 */
export async function demoAction(input: unknown): Promise<DemoResult> {
  const { user } = await requireAdmin();
  const ctx = appCtx();
  // NOC design §N1.5: an admin of the subscriber portal is not one here.
  if (ctx.config.site !== 'noc') return { ok: false, message: 'The demo controls are on the NOC site only.' };
  if (ctx.config.core !== 'fake') return { ok: false, message: 'The demo controls work only with the fake core.' };
  const p = demoSchema.safeParse(input);
  if (!p.success) return { ok: false, message: 'Not a demo control.' };
  const d = p.data;
  const fakes = ctx.cores.flatMap((h) => {
    const core = asFakeCore(h.core);
    return core ? [{ id: h.id, core }] : [];
  }) satisfies { id: string; core: FakeCore }[];
  let message: string;
  if (d.op === 'load') {
    fakes.forEach((h, i) => {
      h.core.simReset();
      seedDemo(h.core, i, ctx.now(), fakes.length);
    });
    message = `The demo network is loaded on ${fakes.map((h) => h.id).join(', ')}.`;
  } else {
    const h = fakes.find((x) => x.id === d.core);
    if (!h) return { ok: false, message: `No fake core ${d.core}.` };
    if (d.op === 'down') {
      const mode: FakeDown = d.mode === 'none' ? null : d.mode;
      h.core.simDown(mode);
      message = mode === null ? `${h.id} answers again.` : `${h.id} now ${mode === 'refuse' ? 'refuses every call' : 'hangs every call'}.`;
    } else {
      try {
        h.core.simCellOnline(d.cellId, d.online);
      } catch {
        return { ok: false, message: `No cell ${d.cellId} on ${h.id}.` };
      }
      message = `Cell ${d.cellId} on ${h.id} is ${d.online ? 'online' : 'offline'}.`;
    }
  }
  forgetSnapshot(ctx);
  forgetActivity(ctx);
  writeAudit(ctx, { actorId: user.id, action: `demo.${d.op}`, detail: d, ip: (await requestMeta()).ip });
  return { ok: true, message };
}
