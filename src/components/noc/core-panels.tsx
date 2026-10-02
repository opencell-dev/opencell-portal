import type { CoreBlock, OcssPeer, OcssState } from '@/core/types';
import { CORE_AUDIT_EVENTS } from '@/core/wire-noc';
import type { Reported } from '@/lib/core-ask';
import type { CoreAuditView } from '@/lib/noc/core-audit';
import { exact, groupNumber } from '@/lib/noc/format';
import { StatusDot, type Tone, When } from './status';

// A core's page (plan N2a): its OCSS links (ocss.status), its blocks
// (core.blocks), and its own audit beside the portal's (audit.list).

const OCSS_TONE: Record<OcssState, Tone> = { up: 'ok', open: 'warn', handshake: 'warn', connecting: 'warn', down: 'bad' };

/** A core's answer for a view that cannot show its own data: "needs oc-core v0.4.0" for an older core, never red (review I4c). Shared with the call page. */
export function notReported<T>(r: Reported<T> | undefined, what: string): string | null {
  if (!r || r.state === 'unsupported') return `Not reported by this core (${what} needs oc-core v0.4.0).`;
  if (r.state === 'unreachable') return 'The core did not answer in time.';
  return null;
}

export function OcssTable({ ocss, now }: { ocss: Reported<OcssPeer[]> | undefined; now: number }) {
  const why = notReported(ocss, 'ocss.status');
  if (why || ocss?.state !== 'ok') return <p className="text-sm text-slate-500">{why}</p>;
  if (ocss.value.length === 0) return <p className="text-sm text-slate-500">No OCSS peer is configured on this core.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="py-1 pr-4">Peer core</th>
            <th className="py-1 pr-4">State</th>
            <th className="py-1 pr-4">Since</th>
            <th className="py-1 pr-4">Who dials</th>
            <th className="py-1 pr-4">Last in / out</th>
            <th className="py-1 pr-4 text-right">Calls</th>
            <th className="py-1 text-right">Bad frames</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {ocss.value.map((p) => (
            <tr key={p.coreId} className="border-b border-slate-100 dark:border-slate-900">
              <td className="py-1 pr-4 font-mono">core {p.coreId}</td>
              <td className="py-1 pr-4">
                <StatusDot tone={OCSS_TONE[p.state]} label={p.state} />
              </td>
              <td className="py-1 pr-4">
                <When t={p.since} now={now} />
              </td>
              <td className="py-1 pr-4">{p.dials ? <span className="font-mono">this core, to {p.address}</span> : 'the peer dials this core'}</td>
              <td className="py-1 pr-4">
                <When t={p.lastRxAt} now={now} /> / <When t={p.lastTxAt} now={now} />
              </td>
              <td className="py-1 pr-4 text-right font-mono">{p.calls}</td>
              <td className="py-1 text-right font-mono">{p.dropped}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BlockTable({ blocks }: { blocks: Reported<CoreBlock[]> | undefined }) {
  const why = notReported(blocks, 'core.blocks');
  if (why || blocks?.state !== 'ok') return <p className="text-sm text-slate-500">{why}</p>;
  return (
    <table className="w-full max-w-2xl text-left text-sm">
      <thead className="text-xs uppercase text-slate-500">
        <tr className="border-b border-slate-200 dark:border-slate-800">
          <th className="py-1 pr-4">Block</th>
          <th className="py-1 pr-4">Prefix</th>
          <th className="py-1 pr-4">Home core</th>
          <th className="py-1">This core</th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {blocks.value.map((b) => (
          <tr key={`${b.index}-${b.prefix}`} className="border-b border-slate-100 dark:border-slate-900">
            <td className="py-1 pr-4 font-mono">{b.index}</td>
            <td className="py-1 pr-4 font-mono">+{b.prefix}</td>
            <td className="py-1 pr-4 font-mono">core {b.homeCore}</td>
            <td className="py-1">{b.role === 'home' ? 'home' : b.role === 'secondary' ? 'secondary' : 'routes to its home over OCSS'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The core's newest audit records, each with the account it names and this site's matching records. */
export function CoreAuditTable({ view }: { view: CoreAuditView }) {
  const r = view.records;
  if (r.state === 'unsupported') return <p className="text-sm text-slate-500">Not reported by this core (audit.list needs oc-core v0.4.0).</p>;
  if (r.state === 'unreachable') return <p className="text-sm text-slate-500">The core&apos;s audit is not read yet, or the core did not answer; try again in a minute.</p>;
  if (r.value.length === 0) return <p className="text-sm text-slate-500">No records.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="py-1 pr-4">Time (UTC)</th>
            <th className="py-1 pr-4">Event</th>
            <th className="py-1 pr-4">Record</th>
            <th className="py-1 pr-4">Number / cell</th>
            <th className="py-1 pr-4">Account</th>
            <th className="py-1">This site&apos;s audit (± 5 s)</th>
          </tr>
        </thead>
        <tbody>
          {r.value.map(({ record: x, who, portal }) => (
            <tr key={x.id} className="border-b border-slate-100 align-top dark:border-slate-900">
              <td className="py-1 pr-4 font-mono tabular-nums">{exact(x.at).replace(' UTC', '')}</td>
              <td className="py-1 pr-4">{CORE_AUDIT_EVENTS[x.event] ?? x.event}</td>
              <td className="py-1 pr-4 font-mono text-xs">{x.detail}</td>
              <td className="py-1 pr-4 font-mono text-xs">
                {x.number ? groupNumber(x.number) : ''}
                {x.cellId !== null ? ` cell ${x.cellId}` : ''}
              </td>
              <td className="py-1 pr-4 text-xs">
                {who === null
                  ? ''
                  : who.kind === 'polls'
                    ? 'the NOC itself (shared polls)'
                    : who.kind === 'this-site'
                      ? (view.emails[who.userId] ?? `account ${who.userId}`)
                      : `the other site's account a${who.actor}`}
              </td>
              <td className="py-1 text-xs">
                {portal.map((p) => (
                  <div key={p.id}>
                    {p.action}
                    {p.target ? ` ${p.target}` : ''}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
