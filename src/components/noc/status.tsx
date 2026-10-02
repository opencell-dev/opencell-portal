import { ago, exact } from '@/lib/noc/format';

// The NOC's status vocabulary (NOC design §9): green ok, amber warning,
// red down, blue information, grey off. Colour is never the only signal:
// every dot carries its word.

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'off';

const DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-600',
  info: 'bg-sky-500',
  off: 'bg-slate-400',
};

const TEXT: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-red-700 dark:text-red-400',
  info: 'text-sky-700 dark:text-sky-400',
  off: 'text-slate-500',
};

export function StatusDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${TEXT[tone]}`}>
      <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${DOT[tone]}`} />
      {label}
    </span>
  );
}

/** A relative time with the exact UTC time as its title; "never" for none. */
export function When({ t, now }: { t: number | null; now: number }) {
  if (t === null) return <span className="text-slate-500">never</span>;
  return (
    <time dateTime={new Date(t).toISOString()} title={exact(t)}>
      {ago(t, now)}
    </time>
  );
}

/** A cell's state as a dot: revoked, online, offline, or never connected. */
export function cellTone(c: { revoked: boolean; online: boolean; lastHeardAt: number | null }): { tone: Tone; label: string } {
  if (c.revoked) return { tone: 'off', label: 'Revoked' };
  if (c.online) return { tone: 'ok', label: 'Online' };
  if (c.lastHeardAt === null) return { tone: 'info', label: 'Never connected' };
  return { tone: 'warn', label: 'Offline' };
}
