'use client';

import { useActionState } from 'react';
import type { FormState } from '@/app/actions/auth';
import { submitRequestAction } from '@/app/actions/nodes';
import { AgreementText } from '@/components/nodes/agreement-text';
import { PinInput } from '@/components/nodes/pin-input';
import { FormMessage } from '@/components/numbers/form-message';

const input = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900';
const label = 'block text-sm';

/** The request (portal spec §6.1): the site, its pin, the hardware, backhaul, power, a contact phone, and the agreement. */
export function RequestForm({ regions, agreementVersion }: { regions: readonly string[]; agreementVersion: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(submitRequestAction, null);
  return (
    <form action={action} className="max-w-2xl space-y-5">
      <input type="hidden" name="agreementVersion" value={agreementVersion} />
      <label className={label}>
        <span className="font-medium">Site name</span>
        <input name="siteName" required minLength={3} maxLength={60} className={input} />
        <span className="text-slate-500">Yours and the admins&apos; label. It is not shown publicly.</span>
      </label>
      <PinInput />
      <label className={label}>
        <span className="font-medium">State or province</span>
        <select name="region" required defaultValue="" className={input}>
          <option value="" disabled>
            Pick one
          </option>
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <span className="text-slate-500">This chooses the core your node joins: east or west of the Mississippi.</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          <span className="font-medium">Raspberry Pi model</span>
          <select name="piModel" required defaultValue="pi5" className={input}>
            <option value="pi5">Raspberry Pi 5</option>
            <option value="pi4">Raspberry Pi 4</option>
            <option value="pi3">Raspberry Pi 3</option>
            <option value="other">Something else</option>
          </select>
        </label>
        <label className={label}>
          <span className="font-medium">Number of W12 boards</span>
          <input name="w12Boards" type="number" min={1} max={4} defaultValue={1} required className={input} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input name="gps" type="checkbox" />
        <span>A GPS receiver is fitted to the board</span>
      </label>
      <label className={label}>
        <span className="font-medium">Antenna</span>
        <input name="antenna" required minLength={2} maxLength={120} placeholder="Vertical on the roof, 10 m up" className={input} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          <span className="font-medium">Internet connection</span>
          <select name="backhaul" required defaultValue="home" className={input}>
            <option value="home">Home internet</option>
            <option value="cellular">Cellular</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className={label}>
          <span className="font-medium">Power</span>
          <select name="power" required defaultValue="mains" className={input}>
            <option value="mains">Mains</option>
            <option value="mains_battery">Mains and battery</option>
            <option value="solar">Solar</option>
          </select>
        </label>
      </div>
      <label className={label}>
        <span className="font-medium">Contact phone</span>
        <input name="contactPhone" type="tel" required maxLength={20} className={input} />
        <span className="text-slate-500">Only the admins see it.</span>
      </label>
      <details className="rounded border border-slate-200 p-3 dark:border-slate-800">
        <summary className="cursor-pointer font-medium">Base Station Operator Agreement, version {agreementVersion}</summary>
        <div className="mt-3 space-y-3 text-sm">
          <AgreementText />
        </div>
      </details>
      <label className="flex items-center gap-2 text-sm">
        <input name="agree" type="checkbox" required />
        <span>I accept the Base Station Operator Agreement</span>
      </label>
      <button type="submit" disabled={pending} className="rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark disabled:opacity-50">
        Send the request
      </button>
      <FormMessage state={state} />
    </form>
  );
}
