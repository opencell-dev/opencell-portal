import type { Metadata } from 'next';
import { setDirectoryAction } from '@/app/actions/account';
import { ChangeEmailForm, DeleteAccountForm, RemovePasskeyButton } from '@/components/account-forms';
import { PasskeyRegister } from '@/components/passkey-register';
import { appCtx } from '@/lib/ctx';
import { ownedNumbers } from '@/lib/owned-numbers';
import { listPasskeys } from '@/lib/passkeys';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Account' };

const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : 'never');

export default async function Account({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { user } = await requireUser();
  const { email } = await searchParams;
  const ctx = appCtx();
  const keys = listPasskeys(ctx, user.id);
  return (
    <div className="max-w-2xl space-y-10">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">Account</h1>
        {email === 'changed' && <p role="status">Your email address is now {user.email}.</p>}
        <p>
          {user.name} · <span data-testid="account-email">{user.email}</span>
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Email</h2>
        <ChangeEmailForm />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Directory</h2>
        <p>
          {user.directoryListed
            ? 'You are listed: signed-in subscribers can find your name and numbers.'
            : 'You are not listed in the directory.'}
        </p>
        <form action={setDirectoryAction}>
          <input type="hidden" name="listed" value={user.directoryListed ? '0' : '1'} />
          <button type="submit" className="rounded border border-slate-300 px-4 py-2 dark:border-slate-700">
            {user.directoryListed ? 'Stop listing me' : 'List me in the directory'}
          </button>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Passkeys</h2>
        {keys.length === 0 ? (
          <p>You have no passkey yet: you sign in with email links.</p>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{k.name}</span>{' '}
                  <span className="text-sm text-slate-500">
                    added {day(k.createdAt)}, last used {day(k.lastUsedAt)}
                  </span>
                </span>
                <RemovePasskeyButton id={k.id} name={k.name} />
              </li>
            ))}
          </ul>
        )}
        <PasskeyRegister />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-red-600">Delete account</h2>
        <DeleteAccountForm numbers={ownedNumbers(ctx, user.id)} />
      </section>
    </div>
  );
}
