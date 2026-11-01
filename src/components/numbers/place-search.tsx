'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { confirmHref, shortlistHref } from '@/lib/numbers/format';
import { parseTyped } from '@/lib/numbers/input';
import type { Place } from '@/lib/numbers/places';

const input = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900';

/**
 * "Where?" (portal spec §4.1 step 1): suggestions as the subscriber types
 * (GET /api/places, 250 ms after the last key), or, without JavaScript, the
 * same list from the page after Search. A whole number goes to the confirm step.
 */
export function PlaceSearch({ q: q0, places: p0 }: { q: string; places: Place[] }) {
  const [q, setQ] = useState(q0);
  const [places, setPlaces] = useState(p0);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const seq = useRef(0);
  const typed = q.trim() === '' ? null : parseTyped(q);

  useEffect(() => {
    // Every change voids the answer still on its way.
    const mine = ++seq.current;
    setBusy(false);
    setRefused(null);
    if (q.trim() === '' || typed?.kind === 'bad') {
      setPlaces([]);
      return;
    }
    if (q === q0) {
      setPlaces(p0); // back to what the server listed
      return;
    }
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await fetch(`/api/places?q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } });
        const body = (await r.json()) as { places?: Place[]; error?: string };
        if (mine !== seq.current) return;
        setPlaces(body.places ?? []);
        setRefused(body.error ?? null);
      } catch {
        if (mine === seq.current) setPlaces([]);
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, q0, p0, typed?.kind]);

  return (
    <div className="space-y-4">
      <form method="get" action="/numbers/new" className="space-y-2" role="search">
        <label className="block">
          <span className="text-sm font-medium">A city, a state, an area code, an exchange, or a whole number</span>
          <input
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={64}
            autoComplete="off"
            placeholder="Lancaster, PA · 717 · 717-464 · 717-464-12345"
            className={input}
          />
        </label>
        <button type="submit" className="rounded border border-slate-300 px-4 py-2 dark:border-slate-700">
          Search
        </button>
      </form>
      {typed?.kind === 'bad' && (
        <p role="alert" className="text-sm text-red-600">
          {typed.message}
        </p>
      )}
      {refused && (
        <p role="alert" className="text-sm text-red-600">
          {refused}
        </p>
      )}
      {typed?.kind === 'number' && (
        <p>
          <Link href={confirmHref(typed.number)} prefetch={false} className="font-medium text-brand underline">
            Check {typed.number} →
          </Link>
        </p>
      )}
      <ul aria-label="Places" aria-busy={busy} className="divide-y divide-slate-200 dark:divide-slate-800">
        {places.map((p) => (
          <li key={`${p.region}|${p.rateCenter}`}>
            <Link href={shortlistHref(p.exchanges[0])} prefetch={false} className="block py-2 hover:underline">
              {p.label}
            </Link>
          </li>
        ))}
      </ul>
      {q.trim() !== '' && typed?.kind !== 'bad' && typed?.kind !== 'number' && places.length === 0 && !busy && !refused && (
        <p className="text-sm text-slate-500">No place matches yet. Try a nearby city, the state, or an area code.</p>
      )}
    </div>
  );
}
