'use client';

import { useState } from 'react';
import { registrationsAction } from '@/app/actions/admin-noc';
import type { Registration } from '@/core/types';
import { TerminalTable } from './terminal-table';

/**
 * A core's registrations, a page at a time (plan N2a): the first page comes
 * with the page; "Next page" asks for the numbers after the last one shown,
 * by POST (registrationsAction), so no number goes into a URL.
 */
export function RegistrationPager({
  core,
  cellId,
  first,
  more,
  now,
}: {
  core: string;
  cellId?: number;
  first: Registration[];
  more: boolean;
  now: number;
}) {
  const [pages, setPages] = useState<Registration[][]>([first]);
  const [hasMore, setHasMore] = useState(more);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const shown = pages[pages.length - 1];

  async function next() {
    setBusy(true);
    setMessage('');
    try {
      const r = await registrationsAction({ core, cellId, after: shown[shown.length - 1].number });
      if (!r.ok) {
        setMessage(r.message);
        return;
      }
      setPages([...pages, r.rows]);
      setHasMore(r.more);
    } catch {
      setMessage("Couldn't reach the portal or your session has ended. Sign in again with your passkey.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        Page {pages.length}: {shown.length} {shown.length === 1 ? 'terminal' : 'terminals'}, by number.
      </p>
      <TerminalTable rows={shown} now={now} core={core} />
      <div className="flex gap-2">
        {pages.length > 1 && (
          <button
            type="button"
            onClick={() => {
              setPages(pages.slice(0, -1));
              setHasMore(true);
            }}
            className="rounded border border-slate-300 px-3 py-1 text-sm dark:border-slate-700"
          >
            Previous page
          </button>
        )}
        {hasMore && (
          <button type="button" disabled={busy} onClick={() => void next()} className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-slate-700">
            Next page
          </button>
        )}
      </div>
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
