import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Countdown } from '@/components/numbers/countdown';
import { CopyButton, EmailQrForm, ReissueForm, SimulateForm } from '@/components/numbers/qr-actions';
import { appCtx } from '@/lib/ctx';
import { countdown, fromSegment, spacedNumber, utcMinute } from '@/lib/numbers/format';
import { numberOf, syncDue } from '@/lib/numbers/ownership';
import { placeOfNumber } from '@/lib/numbers/places';
import { flashOf } from '@/lib/numbers/qr-flash';
import { qrSvg } from '@/lib/qr';
import { requireUser } from '@/server/request';

export const metadata: Metadata = { title: 'Activate your number', robots: { index: false, follow: false } };

/**
 * Get a number, step 4 "Activate" (portal spec §4.1): the QR, its live
 * countdown, the text form, "email it to me". The QR comes from this
 * session's 15-minute flash only (never stored); after that, a new one is a
 * re-issue (P2 decision 2). Another account's number is a 404.
 */
export default async function Activate({ params }: { params: Promise<{ number: string }> }) {
  const { user, session } = await requireUser();
  const ctx = appCtx();
  const number = fromSegment((await params).number);
  // What the core says now: right after a scan, the QR just used must not show as "works once".
  await syncDue(ctx, user.id);
  const row = numberOf(ctx, user.id, number);
  if (!row) notFound();
  const place = placeOfNumber(ctx, number);
  const activated = row.state === 'activated';
  // A QR issued before the number was activated is the one the terminal used: it works no more.
  const flash = flashOf(session.id, number, ctx.now());
  const t = flash && !(activated && row.activatedAt !== null && row.activatedAt >= flash.at) ? flash.token : null;
  return (
    <div className="max-w-xl space-y-6">
      <p>
        <Link href="/numbers" className="text-sm underline">
          ← My numbers
        </Link>
      </p>
      <div>
        <h1 className="text-2xl font-semibold">Activate {spacedNumber(number)}</h1>
        {place && <p className="text-sm text-slate-500">{place}</p>}
      </div>
      {t ? (
        <>
          <p>
            Scan this with the terminal you want this number on.{' '}
            {activated ? 'When it activates, the terminal the number is on now stops working.' : ''}
          </p>
          <div
            className="mx-auto w-full max-w-xs rounded bg-white p-2 [&>svg]:h-auto [&>svg]:w-full"
            role="img"
            aria-label={`Activation QR code for ${spacedNumber(number)}`}
            data-testid="qr"
            // Drawn on the server by qrcode from the token's text: an SVG of paths, nothing that runs.
            dangerouslySetInnerHTML={{ __html: await qrSvg(t.qr) }}
          />
          <p>
            It works once, for <Countdown expiresAt={t.expiresAt} initial={countdown(t.expiresAt - ctx.now())} /> more (until{' '}
            {utcMinute(t.expiresAt)}). If no terminal activates the number by then, it goes back to the pool.
          </p>
          <details>
            <summary className="cursor-pointer underline">Show as text</summary>
            <div className="mt-2 flex items-start gap-2">
              <code className="block break-all rounded bg-slate-100 p-2 text-xs dark:bg-slate-900" data-testid="qr-text">
                {t.qr}
              </code>
              <CopyButton text={t.qr} />
            </div>
          </details>
          <EmailQrForm number={number} />
          <p className="text-sm text-slate-500">
            This page shows the code for 15 minutes, to you only. Anyone with it can take the number, so keep it to yourself.
          </p>
          {ctx.config.core === 'fake' && !activated && (
            <SimulateForm number={number} op="activate" label="Simulate a terminal activating it (fake core)" />
          )}
        </>
      ) : (
        <div className="space-y-3">
          <p>
            {activated
              ? 'This number is active on a terminal. To move it to a new terminal, make a new QR code: the terminal it is on now stops working once the new one activates.'
              : 'This QR code has been shown already. Make a new one (the old one stops working).'}
          </p>
          <ReissueForm
            number={number}
            label={activated ? 'Move to a new terminal' : 'Make a new QR code'}
            warning={activated ? 'The terminal this number is on now will be cut off.' : 'The old QR code stops working.'}
          />
        </div>
      )}
    </div>
  );
}
