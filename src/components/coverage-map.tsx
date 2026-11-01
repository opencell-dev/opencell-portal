import { BASEMAP } from '@/content/basemap';
import type { PublicNode } from '@/lib/coverage';
import { fitView, project } from '@/lib/map-projection';

const STATE = (online: boolean | null) => (online === true ? 'Online' : online === false ? 'Offline' : 'Unknown');
const DOT = (online: boolean | null) => (online === true ? 'fill-emerald-600' : 'fill-slate-400');

/**
 * The public map (portal spec §5): the basemap and a dot per node, all drawn on
 * the server, with no script, no tiles and no outside request. The table is the
 * same nodes, for a screen reader or a page too small to read the map on.
 */
export function CoverageMap({ nodes }: { nodes: PublicNode[] }) {
  const [x, y, w, h] = fitView(nodes);
  const r = Math.max(w, h) / 90;
  return (
    <div className="space-y-4">
      <svg role="img" aria-label="Coverage map" viewBox={`${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`} className="max-h-[70vh] w-full rounded border border-slate-200 bg-sky-50 dark:border-slate-800 dark:bg-slate-900">
        {BASEMAP.regions.map((g) => (
          <path key={g.code} d={g.d} vectorEffect="non-scaling-stroke" strokeWidth={0.5} className="fill-slate-100 stroke-slate-400 dark:fill-slate-800 dark:stroke-slate-600" />
        ))}
        {nodes.map((n) => {
          const [cx, cy] = project(n.lat, n.lon);
          return (
            <circle key={n.label} cx={cx.toFixed(1)} cy={cy.toFixed(1)} r={r.toFixed(2)} vectorEffect="non-scaling-stroke" strokeWidth={1} className={`${DOT(n.online)} stroke-white`}>
              <title>{`${n.label}, ${n.region}: ${STATE(n.online).toLowerCase()}`}</title>
            </circle>
          );
        })}
      </svg>
      <p className="flex flex-wrap gap-4 text-sm text-slate-600 dark:text-slate-300">
        <span>
          <svg viewBox="0 0 10 10" aria-hidden="true" className="mr-1 inline size-3">
            <circle cx="5" cy="5" r="4" className="fill-emerald-600" />
          </svg>
          Online
        </span>
        <span>
          <svg viewBox="0 0 10 10" aria-hidden="true" className="mr-1 inline size-3">
            <circle cx="5" cy="5" r="4" className="fill-slate-400" />
          </svg>
          Offline or unknown
        </span>
      </p>
      {nodes.length === 0 ? (
        <p className="rounded border border-dashed border-slate-300 p-6 text-center text-slate-500 dark:border-slate-700">No base stations are listed yet. They appear here as the first ones are set up.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className="py-2 pr-4">Node</th>
                <th className="py-2 pr-4">State or province</th>
                <th className="py-2 pr-4">Approximate position</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.label} className="border-b border-slate-100 dark:border-slate-900" data-testid="coverage-node">
                  <td className="py-1 pr-4">{n.label}</td>
                  <td className="py-1 pr-4">{n.region}</td>
                  <td className="py-1 pr-4">
                    {n.lat}, {n.lon}
                  </td>
                  <td className="py-1">{STATE(n.online)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
