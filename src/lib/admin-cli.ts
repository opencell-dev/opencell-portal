import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { userRoles, users } from '@/db/schema';
import { listAudit, writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import { errorKind } from '@/lib/errors';
import { applyNanpa, fetchNanpa, liveExchanges, logFailedRefresh, logOffers, type NanpaFiles, readNanpaDir } from '@/lib/numbers/nanpa-refresh';
import { type OfferResult, offerMissingNpas } from '@/lib/numbers/route-delegate';
import { listPasskeys } from '@/lib/passkeys';
import { isLimitName, LIMITS, limitOf, setLimit } from '@/lib/ratelimit';
import { findUserByEmail, grantRole, revokeRole, rolesOf } from '@/lib/users';
import { emailSchema, firstError, nameSchema } from '@/lib/validation';

export const USAGE = `usage: oc-portal-admin COMMAND
  users                          list accounts and their roles
  add EMAIL NAME...              (NOC site) add an account for a staff member
  promote EMAIL                  make a verified account an admin
  demote EMAIL                   take the admin role away
  noc-grant EMAIL                (NOC site) make a verified account a NOC operator
  noc-revoke EMAIL               (NOC site) take the NOC operator role away
  limit show                     show the rate limits
  limit set NAME MAX [WINDOW_S]  change a rate limit (${Object.keys(LIMITS).join(', ')})
  audit [N]                      the last N portal audit records (default 20)
  nanpa-refresh [--dir DIR]      import NANPA's exchanges (weekly timer), then sign and offer
                                 the new NPAs; --dir reads co-codes.txt, npas.csv,
                                 cnac.csv, rc_XX.xml from DIR`;

type Out = { code: number; out: string };

function table(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i] + 2))).join('')).join('\n');
}

/** The portal's admin commands, run on the guest by root (bootstrap and recovery). */
export function runAdmin(ctx: Ctx, argv: string[]): Out {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'users': {
      const rows = ctx.db.select().from(users).orderBy(asc(users.id)).all();
      return {
        code: 0,
        out: table([
          ['id', 'email', 'verified', 'roles'],
          ...rows.map((u) => [String(u.id), u.email, u.emailVerifiedAt ? 'yes' : 'no', rolesOf(ctx, u.id).join(',') || '-']),
        ]),
      };
    }
    case 'add': {
      // NOC design §N1.5: the NOC's site has no sign-up. The account starts
      // unverified, like a sign-up; its first emailed link verifies it.
      if (args.length < 2) return { code: 2, out: USAGE };
      if (ctx.config.site !== 'noc') {
        return { code: 1, out: 'accounts on the subscriber portal come from sign-up; add is for the NOC site (OC_SITE=noc)' };
      }
      const p = z.object({ email: emailSchema, name: nameSchema }).safeParse({ email: args[0], name: args.slice(1).join(' ') });
      if (!p.success) return { code: 1, out: firstError(p.error) };
      const { email, name } = p.data;
      if (findUserByEmail(ctx, email)) return { code: 1, out: `${email} already has an account` };
      const id = ctx.db.insert(users).values({ name, email, createdAt: ctx.now() }).returning({ id: users.id }).get().id;
      writeAudit(ctx, { actorId: null, action: 'account.add', target: `user:${id}` });
      return {
        code: 0,
        out: `${email} added. Next, within 7 days: they open ${ctx.config.origin}/sign-in, ask for an email link and add a passkey on Account; then run promote or noc-grant for them.`,
      };
    }
    case 'promote':
    case 'demote': {
      if (args.length !== 1) return { code: 2, out: USAGE };
      const u = findUserByEmail(ctx, args[0]);
      if (!u) return { code: 1, out: `no account with email ${args[0]}` };
      if (cmd === 'promote') {
        if (!u.emailVerifiedAt) return { code: 1, out: `${u.email} has not verified its email yet; sign up and open the link first` };
        // The NOC's site (NOC design §N1.5), as noc-grant (review I3): staff
        // cannot add a first passkey, so an admin with none could never sign in.
        if (ctx.config.site === 'noc' && listPasskeys(ctx, u.id).length === 0) {
          return { code: 1, out: `${u.email} has no passkey yet: ask them to add one on Account first` };
        }
        grantRole(ctx, u.id, 'admin', null);
        return { code: 0, out: `${u.email} is now an admin` };
      }
      const had = ctx.db.select().from(userRoles).where(eq(userRoles.userId, u.id)).all().some((r) => r.role === 'admin');
      if (!had) return { code: 1, out: `${u.email} is not an admin` };
      const r = revokeRole(ctx, u.id, 'admin', null);
      if (!r.ok) return { code: 1, out: r.error };
      return { code: 0, out: `${u.email} is no longer an admin` };
    }
    case 'noc-grant':
    case 'noc-revoke': {
      if (args.length !== 1) return { code: 2, out: USAGE };
      // NOC design §N1.5: the NOC has its own site and accounts, so the
      // role is granted there. It can still be revoked on the portal (M6,
      // final review): isStaff() would count a stray `noc` row there too
      // (12 h sessions, UV-required passkeys), and SQL would be the only
      // other way to remove one.
      if (cmd === 'noc-grant' && ctx.config.site !== 'noc') {
        return { code: 1, out: 'the NOC role is given on the NOC site (OC_SITE=noc), with its own accounts' };
      }
      const u = findUserByEmail(ctx, args[0]);
      if (!u) return { code: 1, out: `no account with email ${args[0]}` };
      if (cmd === 'noc-grant') {
        if (!u.emailVerifiedAt) return { code: 1, out: `${u.email} has not verified its email yet; sign up and open the link first` };
        // Review I3: staff (admin, noc) need a passkey session to sign in to
        // the NOC at all. Granting the role to an account with none strands
        // it: it has no way to add one, since registering a passkey as
        // staff itself needs a passkey session to confirm.
        if (listPasskeys(ctx, u.id).length === 0) {
          return { code: 1, out: `${u.email} has no passkey yet: ask them to add one on Account first` };
        }
        const added = grantRole(ctx, u.id, 'noc', null);
        return { code: 0, out: added ? `${u.email} is now a NOC operator` : `${u.email} is already a NOC operator` };
      }
      if (!rolesOf(ctx, u.id).includes('noc')) return { code: 1, out: `${u.email} is not a NOC operator` };
      revokeRole(ctx, u.id, 'noc', null);
      return { code: 0, out: `${u.email} is no longer a NOC operator` };
    }
    case 'limit': {
      if (args[0] === 'show' && args.length === 1) {
        const names = Object.keys(LIMITS) as (keyof typeof LIMITS)[];
        return { code: 0, out: names.map((n) => `${n}: ${limitOf(ctx, n).max} per ${limitOf(ctx, n).windowS} s`).join('\n') };
      }
      if (args[0] === 'set' && (args.length === 3 || args.length === 4)) {
        const [, name, max, win] = args;
        if (!isLimitName(name)) return { code: 2, out: USAGE };
        try {
          setLimit(ctx, name, Number(max), win === undefined ? undefined : Number(win));
        } catch (e) {
          return { code: 1, out: (e as Error).message };
        }
        const l = limitOf(ctx, name);
        writeAudit(ctx, { actorId: null, action: 'limit.set', target: name, detail: l });
        return { code: 0, out: `${name}: ${l.max} per ${l.windowS} s` };
      }
      return { code: 2, out: USAGE };
    }
    case 'audit': {
      const n = args[0] === undefined ? 20 : Number(args[0]);
      if (!Number.isInteger(n) || n < 1) return { code: 2, out: USAGE };
      const rows = listAudit(ctx, n);
      return {
        code: 0,
        out: rows
          .map((r) => `${new Date(r.at).toISOString()}  ${r.actorId ?? '-'}  ${r.action}  ${r.target ?? ''}  ${r.detail ?? ''}`.trimEnd())
          .join('\n'),
      };
    }
    default:
      return { code: 2, out: USAGE };
  }
}

/**
 * The CLI's entry point: runAdmin, plus the commands that wait on the
 * network (nanpa-refresh). `fetchFiles` stands in for the download in tests.
 */
export async function runAdminAsync(ctx: Ctx, argv: string[], fetchFiles: () => Promise<NanpaFiles> = () => fetchNanpa()): Promise<Out> {
  const [cmd, ...args] = argv;
  if (cmd !== 'nanpa-refresh') return runAdmin(ctx, argv);
  if (!(args.length === 0 || (args.length === 2 && args[0] === '--dir'))) return { code: 2, out: USAGE };
  // The NOC's guest runs the same bootstrap (and so the same timer), but its
  // site holds no numbers (NOC design §N1.5): nothing to import there.
  if (ctx.config.site !== 'portal') return { code: 0, out: 'nanpa-refresh: the NOC site holds no numbers; nothing to do' };
  try {
    const files = args.length === 2 ? readNanpaDir(args[1]) : await fetchFiles();
    const r = applyNanpa(ctx, files);
    // The import stands whatever happens next: a table problem is logged and the run exits normally.
    const offers: OfferResult = await offerMissingNpas(ctx).catch((e: unknown) => ({ offered: [], replayed: 0, errors: [`the offers failed (${errorKind(e)})`] }));
    logOffers(ctx, offers);
    const lines = [
      `nanpa: ${r.newExchanges} new exchanges, ${r.withdrawn} withdrawn, ${r.restored} restored, ${r.rateCenters} rate centers; ${liveExchanges(ctx)} live`,
      ...(r.newNpas.length > 0 ? [`nanpa: new NPAs ${r.newNpas.join(' ')}`] : []),
      ...r.errors.map((e) => `nanpa: ${e}`),
      ...(offers.offered.length > 0 ? [`route: offered NPAs ${offers.offered.join(' ')}`] : []),
      ...(offers.replayed > 0 ? [`route: ${offers.replayed} additions replayed`] : []),
      ...offers.errors.map((e) => `route: ${e}`),
    ];
    return { code: 0, out: lines.join('\n') };
  } catch (e) {
    logFailedRefresh(ctx, e);
    return { code: 1, out: `nanpa-refresh failed: ${(e as Error)?.message ?? String(e)}` };
  }
}
