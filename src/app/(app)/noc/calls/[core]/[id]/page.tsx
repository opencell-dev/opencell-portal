import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RESULT_LABEL } from '@/components/noc/activity';
import { Leg, ringS, talkS } from '@/components/noc/call-table';
import { notReported } from '@/components/noc/core-panels';
import { CAUSES } from '@/core/wire-noc';
import { appCtx } from '@/lib/ctx';
import { callResult } from '@/lib/noc/activity';
import { getCall } from '@/lib/noc/calls';
import { exact, groupNumber } from '@/lib/noc/format';
import { requestMeta, requireNoc } from '@/server/request';

export const metadata: Metadata = { title: 'Call · NOC' };

/** One call record (plan N2a), by its core and id, read under the viewer's account and audited. */
export default async function NocCall({ params }: { params: Promise<{ core: string; id: string }> }) {
  const { user } = await requireNoc();
  const ctx = appCtx();
  const { core, id } = await params;
  if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 0xffffffff || !ctx.cores.some((c) => c.id === core)) notFound();
  const c = await getCall(ctx, core, Number(id), user.id, (await requestMeta()).ip);
  if (c === null) notFound();
  if (c === 'unreachable' || c === 'unsupported') {
    // Review I4(c): the same wording and the same quiet, grey treatment as every other "not supported by this core" panel -- never a red alert, which belongs to a real failure the viewer must act on.
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">
          Call {id} on {core}
        </h1>
        <p className="text-sm text-slate-500">{notReported(c === 'unsupported' ? { state: 'unsupported' } : { state: 'unreachable' }, 'cdr.recent')}</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href="/noc/calls" prefetch={false} className="text-brand underline">
          Calls
        </Link>{' '}
        / {core} / {c.id}
      </p>
      <h1 className="text-2xl font-semibold">
        {groupNumber(c.caller)} → {groupNumber(c.called)}
      </h1>
      <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-slate-500">Result</dt>
        <dd>
          {RESULT_LABEL[callResult(c)]} (cause {c.cause}: {CAUSES[c.cause] ?? 'other'})
        </dd>
        <dt className="text-slate-500">Set up</dt>
        <dd className="font-mono">{exact(c.setupAt)}</dd>
        <dt className="text-slate-500">Answered</dt>
        <dd className="font-mono">{c.answerAt === null ? 'not answered' : exact(c.answerAt)}</dd>
        <dt className="text-slate-500">Ended</dt>
        <dd className="font-mono">{exact(c.endAt)}</dd>
        <dt className="text-slate-500">Ringing</dt>
        <dd className="font-mono">{ringS(c)} s</dd>
        <dt className="text-slate-500">Talk</dt>
        <dd className="font-mono">{talkS(c)} s</dd>
        <dt className="text-slate-500">Caller&apos;s leg</dt>
        <dd>
          <Leg core={core} cell={c.cellA} kind={c.legA} />
        </dd>
        <dt className="text-slate-500">Called leg</dt>
        <dd>
          <Leg core={core} cell={c.cellB} kind={c.legB} />
        </dd>
        <dt className="text-slate-500">Record</dt>
        <dd className="font-mono">
          {core} CDR {c.id}
        </dd>
      </dl>
      <p className="text-xs text-slate-500">Voice quality (frames lost, concealed) comes with the core telemetry&apos;s phase 2.</p>
    </div>
  );
}
