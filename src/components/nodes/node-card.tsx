import Link from 'next/link';
import { LocalTime } from '@/components/numbers/local-time';
import { ago, modeLabel } from '@/lib/noc/format';
import { cardLine, type NodeCard } from '@/lib/nodes/my-nodes';
import { channelLabel } from '@/lib/nodes/radio-plan';

const TONE = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  off: 'text-red-700 dark:text-red-400',
  wait: 'text-slate-600 dark:text-slate-300',
};

/** One node (portal spec §6.3): online or offline, uptime, last heard, terminals, calls now, the channel and the mode. */
export function NodeCardView({ c, now, link = true }: { c: NodeCard; now: number; link?: boolean }) {
  const line = cardLine(c, now);
  return (
    <div className="space-y-2 rounded-lg border border-slate-300 p-4 dark:border-slate-700" data-testid="node-card">
      <h2 className="font-semibold">
        {link ? (
          <Link href={`/nodes/${c.id}`} className="text-brand underline">
            {c.siteName}
          </Link>
        ) : (
          c.siteName
        )}
      </h2>
      <p className={`font-medium ${TONE[line.tone]}`} data-testid="node-state">
        {line.label}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-500">Last heard</dt>
        <dd>{c.lastHeardAt === null ? 'Not yet' : ago(c.lastHeardAt, now)}</dd>
        <dt className="text-slate-500">Terminals</dt>
        <dd data-testid="node-terminals">{c.terminals ?? '—'}</dd>
        <dt className="text-slate-500">Calls now</dt>
        <dd>{c.calls ?? '—'}</dd>
        <dt className="text-slate-500">Channel</dt>
        <dd data-testid="node-channel">{channelLabel(c.channel.anchor)}</dd>
        <dt className="text-slate-500">Mode</dt>
        <dd>{modeLabel(c.mode)}</dd>
        <dt className="text-slate-500">Cell</dt>
        <dd>
          {c.cellId} on {c.coreId}
        </dd>
      </dl>
      {c.downtime.map((w) => (
        <p key={w.id} className="text-sm" data-testid="node-downtime">
          Downtime notice: <LocalTime t={w.startsAt} /> to <LocalTime t={w.endsAt} />, {w.reason}
        </p>
      ))}
      {c.alertsMuted && <p className="text-sm text-slate-500">Alerts are off.</p>}
    </div>
  );
}
