'use client';

import { useEffect, useState } from 'react';

/** A time in the reader's own time zone; the server, which cannot know it, renders UTC first. */
export function LocalTime({ t }: { t: number }) {
  const utc = `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const [s, setS] = useState(utc);
  useEffect(() => setS(new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })), [t]);
  return (
    <time dateTime={new Date(t).toISOString()} title={utc} suppressHydrationWarning>
      {s}
    </time>
  );
}
