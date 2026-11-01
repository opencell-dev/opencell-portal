import type { Metadata } from 'next';
import Link from 'next/link';
import { RevokeCell } from '@/components/admin/cell-controls';
import { LocalTime } from '@/components/numbers/local-time';
import { allCells } from '@/lib/admin/cells';
import { appCtx } from '@/lib/ctx';
import { ago, modeLabel, shortFpr } from '@/lib/noc/format';
import { channelLabel } from '@/lib/nodes/radio-plan';
import { requireAdmin } from '@/server/request';

export const metadata: Metadata = { title: 'Cells' };

/** Every core's cells, with the portal's nodes beside them (portal spec §1). Exact pins and phones: admins only. */
export default async function AdminCells() {
  const { user } = await requireAdmin();
  const ctx = appCtx();
  const cores = await allCells(ctx, user.id);
  const now = ctx.now();
  return (
    <div className="space-y-6">
      <p>
        <Link href="/admin" className="text-sm underline">
          ← Admin
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Cells</h1>
      {cores.map((c) => (
        <section key={c.coreId} className="space-y-3">
          <h2 className="text-lg font-semibold">{c.coreId}</h2>
          {!c.reachable && <p role="status">This core didn&apos;t answer.</p>}
          {c.reachable && c.rows.length === 0 && <p className="text-sm">No cells.</p>}
          <ul className="space-y-3">
            {c.rows.map((r) => (
              <li key={r.cellId} className="space-y-1 rounded-lg border border-slate-300 p-3 text-sm dark:border-slate-700" data-testid="admin-cell">
                <p className="font-medium">
                  Cell {r.cellId}: {r.name} · {r.revoked ? 'revoked' : r.online ? 'online' : 'offline'}
                </p>
                <p>
                  {modeLabel(r.mode)} · group {r.group} · {r.terminals} terminals · {r.calls} calls · last heard {r.lastHeardAt === null ? 'never' : ago(r.lastHeardAt, now)} · pin {r.certFpr ? shortFpr(r.certFpr) : 'none'}
                </p>
                {r.outside && <p className="text-slate-500">Added outside the portal.</p>}
                {r.node && (
                  <>
                    <p>
                      Node {r.node.id}: {r.node.siteName} · operator {r.node.operator ?? 'none (the account was deleted)'} · {r.node.contactPhone}
                    </p>
                    <p>
                      Exact pin {r.node.lat}, {r.node.lon} · {channelLabel(r.node.anchor)}
                    </p>
                    {r.node.downtime.map((w) => (
                      <p key={w.id} data-testid="admin-downtime">
                        Downtime notice: <LocalTime t={w.startsAt} /> to <LocalTime t={w.endsAt} />, {w.reason}
                      </p>
                    ))}
                  </>
                )}
                {!r.revoked && <RevokeCell coreId={c.coreId} cellId={r.cellId} name={r.name} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
