import type { CoreRow } from '@/lib/core-status';

/**
 * The admin dashboard's Cores section (plan P4b): a card per core with its
 * name, version, cells and subscribers, or "Unreachable". Numbers and
 * subscribers are all on the first core until the East/West split (P5).
 */
export function CoreCards({ rows }: { rows: CoreRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Cores</h2>
      <p className="text-sm text-slate-500">
        Numbers and subscribers are handled by {rows[0]?.id} until the East/West split.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <article key={r.id} className="space-y-2 rounded border border-slate-300 p-3 dark:border-slate-700">
            <h3 className="font-semibold">
              {r.id} <span className="font-mono text-xs font-normal text-slate-500">{r.where}</span>
            </h3>
            {r.status ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <dt className="text-slate-500">Name</dt>
                <dd>{r.status.name}</dd>
                <dt className="text-slate-500">Version</dt>
                <dd>{r.status.version}</dd>
                <dt className="text-slate-500">Cells online</dt>
                <dd>
                  {r.status.cellsOnline} / {r.status.cellsTotal}
                </dd>
                <dt className="text-slate-500">Subscribers</dt>
                <dd>{r.status.subscribers}</dd>
              </dl>
            ) : (
              <p className="text-sm text-red-700 dark:text-red-400">Unreachable</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
