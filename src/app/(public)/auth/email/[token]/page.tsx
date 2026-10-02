import type { Metadata } from 'next';
import Link from 'next/link';
import { confirmEmailLinkAction } from '@/app/actions/auth';
import { ConfirmButton } from '@/components/confirm-button';
import { peekEmailToken } from '@/lib/accounts';
import { appCtx } from '@/lib/ctx';

export const metadata: Metadata = { title: 'Email link' };

const WHAT = {
  verify: ['Confirm your email', 'Confirm my email'],
  magic: ['Sign in to OpenCell', 'Sign in'],
  email_change: ['Confirm your new email', 'Use this address'],
} as const;

// Mail scanners open links; the token is used only by the button's POST.
export default async function EmailLink({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = appCtx();
  const { purpose, state } = peekEmailToken(ctx, token);
  if (state !== 'ok' || !purpose) {
    const why = state === 'expired' ? 'This link has expired.' : state === 'used' ? 'This link has already been used.' : 'This link is not valid.';
    return (
      <div className="max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">{why}</h1>
        <p>
          <Link href="/sign-in" className="text-brand underline">
            Ask for a new sign-in link
          </Link>
          {ctx.config.site === 'portal' && (
            <>
              {' '}
              or{' '}
              <Link href="/sign-up" className="text-brand underline">
                sign up again
              </Link>
            </>
          )}
          .
        </p>
      </div>
    );
  }
  const [title, button] = WHAT[purpose];
  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <form action={confirmEmailLinkAction.bind(null, token)}>
        <ConfirmButton label={button} />
      </form>
    </div>
  );
}
