'use client';

import { useEffect, useState } from 'react';
import { countdown } from '@/lib/numbers/format';

/**
 * The live countdown to a token's expiry (portal spec §4.1 step 4), updated
 * every second from the browser's clock. The server renders the first value,
 * so the page reads right before (or without) JavaScript.
 */
export function Countdown({ expiresAt, initial }: { expiresAt: number; initial: string }) {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    const tick = () => setLeft(countdown(expiresAt - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return (
    <span data-testid="countdown" suppressHydrationWarning>
      {left}
    </span>
  );
}
