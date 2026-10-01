import { asc, eq } from 'drizzle-orm';
import { userRoles, users } from '@/db/schema';
import { listAudit, writeAudit } from '@/lib/audit';
import type { Ctx } from '@/lib/ctx';
import { isLimitName, LIMITS, limitOf, setLimit } from '@/lib/ratelimit';
import { findUserByEmail, grantRole, revokeRole, rolesOf } from '@/lib/users';

export const USAGE = `usage: oc-portal-admin COMMAND
  users                          list accounts and their roles
  promote EMAIL                  make a verified account an admin
  demote EMAIL                   take the admin role away
  noc-grant EMAIL                make a verified account a NOC operator
  noc-revoke EMAIL               take the NOC operator role away
  limit show                     show the rate limits
  limit set NAME MAX [WINDOW_S]  change a rate limit (${Object.keys(LIMITS).join(', ')})
  audit [N]                      the last N portal audit records (default 20)`;

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
    case 'promote':
    case 'demote': {
      if (args.length !== 1) return { code: 2, out: USAGE };
      const u = findUserByEmail(ctx, args[0]);
      if (!u) return { code: 1, out: `no account with email ${args[0]}` };
      if (cmd === 'promote') {
        if (!u.emailVerifiedAt) return { code: 1, out: `${u.email} has not verified its email yet; sign up and open the link first` };
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
      const u = findUserByEmail(ctx, args[0]);
      if (!u) return { code: 1, out: `no account with email ${args[0]}` };
      if (cmd === 'noc-grant') {
        if (!u.emailVerifiedAt) return { code: 1, out: `${u.email} has not verified its email yet; sign up and open the link first` };
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
