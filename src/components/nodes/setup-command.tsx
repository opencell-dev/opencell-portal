'use client';

import { useActionState } from 'react';
import { newSetupCommandAction, type SetupCommandState } from '@/app/actions/nodes';
import { LocalTime } from '@/components/numbers/local-time';

const code = 'block overflow-x-auto whitespace-pre rounded bg-slate-100 p-2 font-mono text-xs dark:bg-slate-900';

/** "Make a new setup command" (decision 10): tokens are stored hashed, so one is shown only here, once, and in the approval mail. */
export function SetupCommand({ id, hasCert }: { id: number; hasCert: boolean }) {
  const [state, action, pending] = useActionState<SetupCommandState, FormData>(newSetupCommandAction, null);
  return (
    <div className="space-y-3">
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <button type="submit" disabled={pending} className="rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark disabled:opacity-50">
          Make a new setup command
        </button>
      </form>
      {state && !state.ok && (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      )}
      {state?.ok && (
        <div className="space-y-3 text-sm" role="status">
          <p>
            On the Pi, with the W12 board on USB. It works once, until <LocalTime t={state.expiresAt} />. Any earlier command has stopped working.
          </p>
          <div>
            <p className="font-medium">{hasCert ? 'Run setup again (keeps this Pi’s key)' : 'Set up the node'}</p>
            <code className={code} data-testid="setup-command">
              {state.command}
            </code>
          </div>
          {hasCert && (
            <div>
              <p className="font-medium">A new certificate with a new key (the old key stops working)</p>
              <code className={code} data-testid="setup-command-new-key">
                {state.newKeyCommand}
              </code>
            </div>
          )}
          <details>
            <summary className="cursor-pointer font-medium">Inspect the script first</summary>
            <p className="my-2">
              It is the same address opened in a browser:{' '}
              <a href={state.inspect} className="text-brand underline" target="_blank" rel="noreferrer">
                the script as plain text
              </a>
            </p>
            <pre className={code} data-testid="setup-script">
              {state.script}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
