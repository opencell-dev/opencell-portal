'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { RELEASED } from '@/lib/numbers/card';
import { activateHref, spacedNumber } from '@/lib/numbers/format';
import type { NumberStatus } from '@/lib/numbers/status';
import { ReissueForm, ReleaseForm, SimulateForm } from './qr-actions';

/** The parts of a card the server knows and the poll doesn't change. */
export interface CardInfo {
  number: string;
  place: string | null;
}

const TONE: Record<NumberStatus['tone'], string> = {
  wait: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  ok: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200',
  warn: 'bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200',
  off: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

const FAST_S = 5;
const SLOW_S = 30;

function lastSeen(t: number | null): string {
  return t === null ? 'never' : new Date(t).toLocaleString();
}

/**
 * The cards of My numbers (portal spec §5), kept live by polling
 * /api/numbers/status (P2 decision 3): every 5 s while a number waits for
 * activation or is not registered, else every 30 s, while the tab is
 * visible. A number the core released since the page loaded stays on screen
 * as "Released (not activated in 3 days)" until the next reload.
 */
export function LiveNumbers({ cards, initial, fake }: { cards: CardInfo[]; initial: NumberStatus[]; fake: boolean }) {
  const [status, setStatus] = useState(() => new Map(initial.map((s) => [s.number, s])));
  const [gone, setGone] = useState<Set<string>>(new Set());
  const busy = useRef(false);
  // A server action (release, re-issue, a simulation) re-renders the page with fresh rows: take them.
  useEffect(() => {
    setStatus(new Map(initial.map((s) => [s.number, s])));
    setGone(new Set());
  }, [initial]);
  const fast = [...status.values()].some((s) => s.state === 'unactivated' || !s.label.startsWith('Registered'));

  useEffect(() => {
    const poll = async () => {
      if (busy.current || document.visibilityState !== 'visible') return;
      busy.current = true;
      try {
        const r = await fetch('/api/numbers/status', { headers: { accept: 'application/json' }, cache: 'no-store' });
        if (!r.ok) return;
        const { numbers } = (await r.json()) as { numbers: NumberStatus[] };
        const next = new Map(numbers.map((s) => [s.number, s]));
        setStatus(next);
        setGone(new Set(cards.map((c) => c.number).filter((n) => !next.has(n))));
      } catch {
        // Offline for a moment: the next poll tries again.
      } finally {
        busy.current = false;
      }
    };
    const t = setInterval(poll, (fast ? FAST_S : SLOW_S) * 1000);
    return () => clearInterval(t);
  }, [fast, cards]);

  return (
    <>
      {cards.map((c) => {
        const s = status.get(c.number);
        const released = gone.has(c.number) || !s;
        const st = released ? RELEASED : s;
        return (
          <article key={c.number} className="space-y-3 rounded-lg border border-slate-300 p-4 dark:border-slate-700" data-testid="number-card" data-number={c.number}>
            <div>
              <h2 className="font-mono text-lg">{spacedNumber(c.number)}</h2>
              {c.place && <p className="text-sm text-slate-500">{c.place}</p>}
            </div>
            <p>
              <span className={`inline-block rounded px-2 py-0.5 text-sm ${TONE[st.tone]}`} data-testid="number-state" aria-live="polite">
                {st.label}
              </span>
            </p>
            {!released && s && s.state === 'activated' && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                <dt className="text-slate-500">Terminal</dt>
                <dd className="font-mono">{s.terminal ?? '—'}</dd>
                <dt className="text-slate-500">Last seen</dt>
                <dd suppressHydrationWarning>{lastSeen(s.lastSeenAt)}</dd>
              </dl>
            )}
            {!released && s && (
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2 text-sm">
                {s.state === 'unactivated' && (
                  <Link href={activateHref(c.number)} className="underline">
                    Show QR
                  </Link>
                )}
                <Link href={`/calls?number=${encodeURIComponent(c.number)}`} className="underline">
                  Calls
                </Link>
                {s.state === 'unactivated' ? (
                  <ReissueForm number={c.number} label="Re-issue QR" warning="The old QR code stops working." />
                ) : (
                  <ReissueForm number={c.number} label="Move to a new terminal" warning="The terminal this number is on now will be cut off once the new one activates." />
                )}
                {s.state === 'unactivated' && <ReleaseForm number={c.number} />}
                {fake && s.state === 'activated' && !s.label.startsWith('Registered') && (
                  <SimulateForm number={c.number} op="register" label="Simulate a registration (fake core)" />
                )}
              </div>
            )}
          </article>
        );
      })}
    </>
  );
}
