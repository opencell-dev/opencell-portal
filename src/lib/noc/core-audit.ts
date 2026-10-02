import type { CoreAuditRecord } from '@/core/types';
import { AUDIT_API } from '@/core/wire-noc';
import { type AuditRow, auditBetween, writeAudit } from '@/lib/audit';
import { askReported, type Reported } from '@/lib/core-ask';
import type { Ctx } from '@/lib/ctx';
import { coreActor, NOC_ACTOR_BASE, type Site } from '@/lib/site';
import { getUser } from '@/lib/users';
import { auditEnd } from './activity';

// A core's own audit beside the portal's (plan N2a; NOC design §15
// conflict 5, decision #15): no correlation id on the admin API, so a core's
// API record and the portal's are matched by account and time (± 5 s).

export const CORRELATE_MS = 5000;
/** The newest this many of a core's records are shown. */
export const CORE_AUDIT_SHOWN = 100;

/** An API record's detail: "a<actor> <op> <status> [what]" (oc_api.h). */
export interface ApiCall {
  actor: number;
  op: string;
  status: string;
  what: string;
}

export function parseApiDetail(detail: string): ApiCall | null {
  const m = /^a(\d+) (\S+) (\S+)(?: (.*))?$/.exec(detail);
  return m ? { actor: Number(m[1]), op: m[2], status: m[3], what: m[4] ?? '' } : null;
}

/** Who a core's actor is, seen from `site`: its shared polls (a0), one of this site's accounts, or the other site's. */
export type Who = { kind: 'polls' } | { kind: 'this-site'; userId: number } | { kind: 'other-site'; actor: number };

export function whoIs(site: Site, actor: number): Who {
  if (actor === 0) return { kind: 'polls' };
  const noc = actor >= NOC_ACTOR_BASE;
  if (site === 'noc') return noc ? { kind: 'this-site', userId: actor - NOC_ACTOR_BASE } : { kind: 'other-site', actor };
  return noc ? { kind: 'other-site', actor } : { kind: 'this-site', userId: actor };
}

export interface Correlated {
  record: CoreAuditRecord;
  call: ApiCall | null;
  who: Who | null;
  /** This site's audit rows by the same account within CORRELATE_MS. */
  portal: AuditRow[];
}

/** Each core record with the portal rows of the same account within ± CORRELATE_MS. */
export function correlate(records: CoreAuditRecord[], rows: AuditRow[], site: Site): Correlated[] {
  return records.map((record) => {
    const call = record.event === AUDIT_API ? parseApiDetail(record.detail) : null;
    const who = call ? whoIs(site, call.actor) : null;
    const portal =
      who?.kind === 'this-site' ? rows.filter((r) => r.actorId === who.userId && Math.abs(r.at - record.at) <= CORRELATE_MS) : [];
    return { record, call, who, portal };
  });
}

export interface CoreAuditView {
  records: Reported<Correlated[]>;
  /** Emails of this site's accounts named, by id. */
  emails: Record<number, string>;
}

/**
 * The newest CORE_AUDIT_SHOWN records of a core's audit, newest first, read
 * as `userId` from where the shared activity found the audit's end, each
 * matched to this site's audit; audited as noc.core.audit.
 */
export async function coreAuditView(ctx: Ctx, core: string, userId: number, ip: string): Promise<CoreAuditView> {
  const h = ctx.cores.find((c) => c.id === core);
  const end = auditEnd(ctx, core);
  if (!h || end === null) return { records: { state: 'unreachable' }, emails: {} };
  const as = coreActor(ctx.config.site, userId);
  const r = await askReported(h, 'audit.list', () => h.core.auditList(as, { after: Math.max(0, end - CORE_AUDIT_SHOWN), limit: 2 * CORE_AUDIT_SHOWN }), 3000);
  writeAudit(ctx, { actorId: userId, action: 'noc.core.audit', target: `core:${core}`, detail: { core, rows: r.state === 'ok' ? r.value.length : r.state }, ip });
  if (r.state !== 'ok') return { records: r, emails: {} };
  const newest = r.value.slice(-CORE_AUDIT_SHOWN).reverse();
  const from = Math.min(...newest.map((x) => x.at), ctx.now()) - CORRELATE_MS;
  const rows = auditBetween(ctx, from, ctx.now() + CORRELATE_MS);
  const records = correlate(newest, rows, ctx.config.site);
  const emails: Record<number, string> = {};
  for (const c of records) {
    if (c.who?.kind === 'this-site' && !(c.who.userId in emails)) {
      const u = getUser(ctx, c.who.userId);
      if (u) emails[c.who.userId] = u.email;
    }
  }
  return { records: { state: 'ok', value: records }, emails };
}
