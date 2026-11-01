'use client';

import { useActionState, useState } from 'react';
import type { FormState } from '@/app/actions/auth';
import { addDowntimeAction, cancelDowntimeAction, retireAction, setAlertsAction, simulateNodeAction } from '@/app/actions/nodes';
import { FormMessage } from '@/components/numbers/form-message';

const input = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900';
const button = 'rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700';

/** The alerts switch (portal spec §6.3): operators can mute a node's offline and back mails. */
export function AlertsSwitch({ id, muted }: { id: number; muted: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(setAlertsAction, null);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="muted" value={muted ? '0' : '1'} />
      <p className="text-sm">{muted ? 'Alerts are off: no mail when this node goes down or comes back.' : 'You get a mail when this node has been offline 10 minutes, and when it is back.'}</p>
      <button type="submit" disabled={pending} className={button}>
        {muted ? 'Turn alerts on' : 'Mute alerts'}
      </button>
      <FormMessage state={state} />
    </form>
  );
}

/** A planned window: the times are the reader's own, sent as unix ms. */
export function DowntimeForm({ id }: { id: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(addDowntimeAction, null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const ms = (s: string) => (s ? String(new Date(s).getTime()) : '');
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="startsAt" value={ms(from)} />
      <input type="hidden" name="endsAt" value={ms(to)} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">From</span>
          <input type="datetime-local" required value={from} onChange={(e) => setFrom(e.target.value)} className={input} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">To</span>
          <input type="datetime-local" required value={to} onChange={(e) => setTo(e.target.value)} className={input} />
        </label>
      </div>
      <label className="block text-sm">
        <span className="font-medium">Why</span>
        <input name="reason" required minLength={3} maxLength={200} className={input} />
      </label>
      <button type="submit" disabled={pending} className={button}>
        Post the notice
      </button>
      <FormMessage state={state} />
    </form>
  );
}

export function CancelDowntimeButton({ id }: { id: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(cancelDowntimeAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={pending} className={button}>
        Cancel this notice
      </button>
      <FormMessage state={state} />
    </form>
  );
}

/** Retiring is a message to the admins (decision 24); they revoke the cell. */
export function RetireForm({ id }: { id: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(retireAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label className="block text-sm">
        <span className="font-medium">A note for the admins</span>
        <textarea name="body" required maxLength={2000} rows={2} className={input} />
      </label>
      <button type="submit" disabled={pending} className={button}>
        Tell the admins I&apos;m retiring this node
      </button>
      <FormMessage state={state} />
    </form>
  );
}

/** The fake core only (development and the browser tests). */
export function SimulateNode({ id, online }: { id: number; online: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(simulateNodeAction, null);
  return (
    <form action={action} className="space-y-1 rounded border border-dashed border-slate-300 p-2 dark:border-slate-700">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="online" value={online ? '0' : '1'} />
      <button type="submit" disabled={pending} className={button}>
        {online ? 'Simulate the node going offline (fake core)' : 'Simulate the node coming online (fake core)'}
      </button>
      <FormMessage state={state} />
    </form>
  );
}
