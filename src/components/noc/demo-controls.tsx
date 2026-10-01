'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { demoAction } from '@/app/actions/admin-noc';

export interface DemoCore {
  id: string;
  down: 'refuse' | 'hang' | null;
  cells: { cellId: number; name: string; online: boolean; revoked: boolean }[];
}

const BTN = 'rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-700';

/** The demo's controls (NOC design §10): each press changes the fake cores in memory, then the page is asked again. */
export function DemoControls({ cores }: { cores: DemoCore[] }) {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function act(input: unknown) {
    setBusy(true);
    try {
      const r = await demoAction(input);
      setMessage(r.message);
      router.refresh();
    } catch {
      setMessage("Couldn't reach the portal or your admin session has ended.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <button type="button" disabled={busy} onClick={() => act({ op: 'load' })} className="rounded bg-brand px-4 py-2 font-medium text-white disabled:opacity-50">
        Load the demo network
      </button>
      {message && <p role="status">{message}</p>}
      {cores.map((c) => (
        <section key={c.id} className="space-y-2 rounded border border-slate-300 p-3 dark:border-slate-700">
          <h2 className="font-semibold">
            {c.id}{' '}
            <span className="text-sm font-normal text-slate-500">
              {c.down === null ? 'answering' : c.down === 'refuse' ? 'refusing every call' : 'hanging every call'}
            </span>
          </h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} className={BTN} onClick={() => act({ op: 'down', core: c.id, mode: 'none' })}>
              Answer normally
            </button>
            <button type="button" disabled={busy} className={BTN} onClick={() => act({ op: 'down', core: c.id, mode: 'refuse' })}>
              Refuse calls ({c.id})
            </button>
            <button type="button" disabled={busy} className={BTN} onClick={() => act({ op: 'down', core: c.id, mode: 'hang' })}>
              Stop answering ({c.id})
            </button>
          </div>
          {c.cells.length > 0 && (
            <ul className="space-y-1 text-sm">
              {c.cells
                .filter((x) => !x.revoked)
                .map((x) => (
                  <li key={x.cellId} className="flex items-center gap-2">
                    <span className="w-40">
                      {x.cellId} {x.name}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      className={BTN}
                      onClick={() => act({ op: 'cell', core: c.id, cellId: x.cellId, online: !x.online })}
                    >
                      {x.online ? `Take ${x.name} offline` : `Bring ${x.name} online`}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
