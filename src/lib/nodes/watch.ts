import { and, desc, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import { nodeDowntime, nodes, nodeState, settings, users } from '@/db/schema';
import { loadCellCa } from '@/lib/ca/cell-ca';
import type { Ctx } from '@/lib/ctx';
import { errorKind } from '@/lib/errors';
import { cellCaExpiringMail, nodeBackMail, nodeOfflineMail, offlineDigestMail } from '@/lib/mail-templates';
import { adminContacts } from '@/lib/users';
import { cellSnapshot } from './my-nodes';

// One watcher in the portal's process (plan P3, decision 19): every 60 s, one
// look per core as actor 0, shared with My nodes. It keeps node_state and sends
// the alerts (portal spec §6.3): a mail after 10 minutes offline, another when
// the node is back; mutes and downtime notices pause them; a core that doesn't
// answer is "unknown", which never alerts. Admins get one digest a day.

export const WATCH_MS = 60_000;
export const OFFLINE_ALERT_MS = 10 * 60_000;
export const DIGEST_HOUR = 8;
export const DIGEST_TZ = 'America/New_York';
export const ICA_WARN_MS = 30 * 86_400_000;
const FIRST_TICK_MS = 30_000;
const DIGEST_DAY = 'nodes:digest_day';
const ICA_WARN_DAY = 'nodes:ica_warn_day';

/** The notice covering this moment, if any. */
export function inDowntime(ctx: Ctx, nodeId: number, at: number): { endsAt: number } | null {
  return (
    ctx.db
      .select({ endsAt: nodeDowntime.endsAt })
      .from(nodeDowntime)
      .where(and(eq(nodeDowntime.nodeId, nodeId), isNull(nodeDowntime.cancelledAt), lte(nodeDowntime.startsAt, at), gt(nodeDowntime.endsAt, at)))
      .orderBy(desc(nodeDowntime.endsAt))
      .get() ?? null
  );
}

/** When a notice that overlapped this outage ended, so the 10 minutes count from there; else null. */
function lastWindowEnd(ctx: Ctx, nodeId: number, since: number, now: number): number | null {
  return (
    ctx.db
      .select({ endsAt: nodeDowntime.endsAt })
      .from(nodeDowntime)
      .where(and(eq(nodeDowntime.nodeId, nodeId), isNull(nodeDowntime.cancelledAt), gt(nodeDowntime.endsAt, since), lte(nodeDowntime.endsAt, now)))
      .orderBy(desc(nodeDowntime.endsAt))
      .get()?.endsAt ?? null
  );
}

function setting(ctx: Ctx, key: string): string | undefined {
  return ctx.db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

function setSetting(ctx: Ctx, key: string, value: string): void {
  ctx.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

/** The local date and hour in New York, DST and all. */
function localClock(t: number): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: DIGEST_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function sendDigest(ctx: Ctx, now: number): boolean {
  const { day, hour } = localClock(now);
  if (hour < DIGEST_HOUR || setting(ctx, DIGEST_DAY) === day) return false;
  const rows = ctx.db
    .select({ nodeId: nodes.id, siteName: nodes.siteName, coreId: nodes.coreId, cellId: nodes.cellId, since: nodeState.offlineSince, operator: users.name })
    .from(nodes)
    .innerJoin(nodeState, eq(nodeState.nodeId, nodes.id))
    .leftJoin(users, eq(users.id, nodes.userId))
    .where(and(isNull(nodes.revokedAt), isNotNull(nodes.certFpr), eq(nodeState.online, false)))
    .all()
    // A notice covers the node: "no alert fires inside a downtime notice".
    .filter((r) => inDowntime(ctx, r.nodeId, now) === null);
  if (rows.length === 0) return false;
  setSetting(ctx, DIGEST_DAY, day);
  for (const a of adminContacts(ctx)) {
    const m = offlineDigestMail(a.name, rows, `${ctx.config.origin}/admin/cells`, ctx.config.origin);
    ctx.mailQueue.send({ to: a.email, subject: m.subject, text: m.text });
  }
  return true;
}

/** Once a day, from 30 days before the intermediate ends (decision 6). */
function warnCellCa(ctx: Ctx, now: number): boolean {
  if (!ctx.config.cellCa) return false;
  let notAfter: number | null;
  try {
    notAfter = loadCellCa(ctx)?.notAfter ?? null;
  } catch (e) {
    // Expired, or the files went away: every setup now fails. Worth the same mail, without details.
    console.error(`oc-portal: ${(e as Error).message}`);
    notAfter = now;
  }
  if (notAfter === null || notAfter - now >= ICA_WARN_MS) return false;
  const { day } = localClock(now);
  if (setting(ctx, ICA_WARN_DAY) === day) return false;
  setSetting(ctx, ICA_WARN_DAY, day);
  for (const a of adminContacts(ctx)) {
    const m = cellCaExpiringMail(a.name, notAfter, ctx.config.origin);
    ctx.mailQueue.send({ to: a.email, subject: m.subject, text: m.text });
  }
  return true;
}

type Sample = Pick<typeof nodeState.$inferSelect, 'online' | 'lastHeardAt' | 'onlineSince' | 'offlineSince' | 'offlineAlertAt'>;

/** How many nodes the watcher last saw offline, for the dashboard. */
export function offlineCount(ctx: Ctx): number {
  return ctx.db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeState, eq(nodeState.nodeId, nodes.id))
    .where(and(isNull(nodes.revokedAt), isNotNull(nodes.certFpr), eq(nodeState.online, false)))
    .all().length;
}

/** One look at every node that has a certificate. */
export async function watchTick(ctx: Ctx): Promise<{ offline: number[]; back: number[]; digest: boolean; icaWarned: boolean }> {
  const offline: number[] = [];
  const back: number[] = [];
  const rows = ctx.db
    .select({ n: nodes, operator: users })
    .from(nodes)
    .leftJoin(users, eq(users.id, nodes.userId))
    .where(and(isNull(nodes.revokedAt), isNotNull(nodes.certFpr)))
    .all();
  const coreIds = [...new Set(rows.map((r) => r.n.coreId))];
  const snaps = new Map(await Promise.all(coreIds.map(async (id) => [id, await cellSnapshot(ctx, id, { fresh: true })] as const)));
  const now = ctx.now();
  const link = (id: number) => `${ctx.config.origin}/nodes/${id}`;
  for (const { n, operator } of rows) {
    const row = ctx.db.select().from(nodeState).where(eq(nodeState.nodeId, n.id)).get();
    const s: Sample = { online: row?.online ?? null, lastHeardAt: row?.lastHeardAt ?? null, onlineSince: row?.onlineSince ?? null, offlineSince: row?.offlineSince ?? null, offlineAlertAt: row?.offlineAlertAt ?? null };
    const cell = snaps.get(n.coreId)?.cells.get(n.cellId);
    let next: Sample;
    if (!cell) {
      // Its core did not answer: unknown. Nothing else changes, and nothing is sent.
      next = { ...s, online: null };
    } else if (cell.online) {
      const continuous = s.online !== false && s.onlineSince !== null;
      next = { online: true, lastHeardAt: cell.lastHeardAt, onlineSince: continuous ? s.onlineSince : now, offlineSince: null, offlineAlertAt: null };
      if (s.offlineAlertAt !== null) {
        const quiet = n.alertsMuted || !operator || inDowntime(ctx, n.id, now) !== null;
        if (!quiet) {
          const m = nodeBackMail(operator.name, n.siteName, link(n.id), ctx.config.origin);
          ctx.mailQueue.send({ to: operator.email, subject: m.subject, text: m.text });
          back.push(n.id);
        }
      }
    } else {
      // First seen offline, or when the core last heard it if that is earlier;
      // never before this certificate, which started the node afresh.
      const heard = Math.max(cell.lastHeardAt ?? now, n.certIssuedAt ?? 0);
      const offlineSince = s.offlineSince ?? Math.min(now, heard);
      next = { online: false, lastHeardAt: cell.lastHeardAt, onlineSince: null, offlineSince, offlineAlertAt: s.offlineAlertAt };
      const notice = inDowntime(ctx, n.id, now);
      const from = Math.max(offlineSince, lastWindowEnd(ctx, n.id, offlineSince, now) ?? offlineSince);
      if (next.offlineAlertAt === null && !notice && now - from >= OFFLINE_ALERT_MS && !n.alertsMuted && operator) {
        const m = nodeOfflineMail(operator.name, n.siteName, offlineSince, link(n.id), ctx.config.origin);
        ctx.mailQueue.send({ to: operator.email, subject: m.subject, text: m.text });
        next.offlineAlertAt = now;
        offline.push(n.id);
      }
    }
    ctx.db
      .insert(nodeState)
      .values({ nodeId: n.id, ...next, checkedAt: now })
      .onConflictDoUpdate({ target: nodeState.nodeId, set: { ...next, checkedAt: now } })
      .run();
  }
  return { offline, back, digest: sendDigest(ctx, now), icaWarned: warnCellCa(ctx, now) };
}

/** Run it: the first tick after 30 s, then every `every` ms. A tick still running is skipped; a failure is logged by its class only. Returns a stop function. */
export function startNodeWatch(ctx: Ctx, every = WATCH_MS): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void watchTick(ctx)
      .catch((e: unknown) => console.error(`oc-portal: node watcher tick failed (${errorKind(e)})`))
      .finally(() => {
        running = false;
      });
  };
  let timer: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    run();
    timer = setInterval(run, every);
    timer.unref();
  }, FIRST_TICK_MS);
  first.unref();
  return () => {
    clearTimeout(first);
    if (timer) clearInterval(timer);
  };
}

