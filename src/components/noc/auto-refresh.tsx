'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Asks the server for the page again every `seconds` while the tab is
 * visible (NOC design §8: polling in N1; server-sent events wait for N2).
 * The page's own data says when the cores were asked.
 */
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [on, seconds, router]);
  return (
    <label className="inline-flex items-center gap-2 text-xs text-slate-500">
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
      Refresh every {seconds} s
    </label>
  );
}
