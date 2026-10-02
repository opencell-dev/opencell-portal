import type { NodeState, TopologyLayout } from '@/lib/noc/topology';

// Server-rendered SVG (NOC design §9.2; ruling R3: no new dependency).
// Colours are Tailwind classes on SVG elements, never style attributes:
// the CSP's style-src has no 'unsafe-inline'.

const FILL: Record<NodeState, string> = {
  ok: 'fill-emerald-500',
  warn: 'fill-amber-500',
  bad: 'fill-red-600',
  info: 'fill-sky-500',
  off: 'fill-slate-400',
};
const STROKE: Record<NodeState, string> = {
  ok: 'stroke-emerald-500',
  warn: 'stroke-amber-500',
  bad: 'stroke-red-600',
  info: 'stroke-sky-500',
  off: 'stroke-slate-400',
};
const WORD: Record<NodeState, string> = { ok: 'online', warn: 'offline', bad: 'unreachable', info: 'never connected', off: 'revoked' };

export function Topology({ t }: { t: TopologyLayout }) {
  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${t.width} ${t.height}`}
        width={t.width}
        height={t.height}
        role="img"
        aria-labelledby="topo-title"
        className="max-w-none font-sans"
      >
        <title id="topo-title">
          {`OpenCell topology: ${t.cores.length} cores, ${t.cells.length} cells. Lines from a cell to its core are IP backhaul; lines between cores are OCSS (solid: up).`}
        </title>
        {t.edges.map((e) =>
          e.bend !== undefined ? (
            <path
              key={`${e.kind}-${e.x1}-${e.y1}-${e.x2}-${e.y2}`}
              d={`M ${e.x1} ${e.y1 - 20} Q ${(e.x1 + e.x2) / 2} ${Math.max(2, e.y1 - 20 - e.bend)} ${e.x2} ${e.y2 - 20}`}
              fill="none"
              strokeWidth={2}
              strokeDasharray={e.state === 'ok' ? undefined : '6 4'}
              className={STROKE[e.state]}
            >
              <title>{e.title}</title>
            </path>
          ) : (
            <line
              key={`${e.kind}-${e.x1}-${e.y1}-${e.x2}-${e.y2}`}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              strokeWidth={e.kind === 'ocss' ? 2 : 1.5}
              strokeDasharray={e.kind === 'ocss' ? (e.state === 'ok' ? undefined : '6 4') : e.state === 'ok' ? undefined : '3 3'}
              className={STROKE[e.state]}
            >
              <title>{e.title}</title>
            </line>
          ),
        )}
        {t.cores.map((c) => (
          <a key={c.id} href={c.href} aria-label={`${c.label}, ${c.sub}`}>
            <rect x={c.x - 80} y={c.y - 25} width={160} height={50} rx={6} strokeWidth={2} className={`fill-white dark:fill-slate-900 ${STROKE[c.state]}`} />
            <text x={c.x} y={c.y - 3} textAnchor="middle" className="fill-slate-900 text-[13px] font-semibold dark:fill-slate-100">
              {c.label}
            </text>
            <text x={c.x} y={c.y + 14} textAnchor="middle" className="fill-slate-500 text-[11px]">
              {c.sub}
            </text>
          </a>
        ))}
        {t.cells.map((c) => (
          <a key={`${c.core}-${c.cellId}`} href={c.href} aria-label={`Cell ${c.cellId} ${c.label}, ${WORD[c.state]}, ${c.terminals} terminals`}>
            <circle cx={c.x} cy={c.y} r={18} className={FILL[c.state]} />
            <text x={c.x} y={c.y + 4} textAnchor="middle" className="fill-white text-[12px] font-semibold">
              {c.terminals}
            </text>
            <text x={c.x} y={c.y + 34} textAnchor="middle" className="fill-slate-700 text-[11px] dark:fill-slate-300">
              {c.label}
            </text>
          </a>
        ))}
      </svg>
    </div>
  );
}
