import type { RadioStatus } from '@/core/types';
import type { Reported } from '@/lib/core-ask';
import { duration } from '@/lib/noc/format';
import { ppsLabel, radioView } from '@/lib/noc/radio';
import { StatusDot, type Tone, When } from './status';

// A cell's radio health (plan N2a): what its latest CELL_STATUS said, per
// radio, through cell.radio. Stale reports and silent boards read
// "unknown" (radio.ts); counters are since the cell's or board's start.

const PPS_TONE: Record<string, Tone> = { locked: 'ok', holdover: 'warn', unlocked: 'bad', unknown: 'off' };

function Counter({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className={`font-mono tabular-nums ${warn ? 'text-amber-700 dark:text-amber-400' : ''}`}>{value}</dd>
    </>
  );
}

function OneRadio({ r, now }: { r: RadioStatus; now: number }) {
  const v = radioView(r, now);
  return (
    <div className="space-y-2 rounded border border-slate-200 p-3 dark:border-slate-800">
      <h3 className="font-semibold">
        Radio {r.radio}{' '}
        <span className="text-sm font-normal text-slate-500">
          {r.role === 'bench' ? 'bench board' : r.role === 'bs' ? 'base-station board' : 'board'}, band {r.band}, firmware {r.fw}
        </span>
      </h3>
      {v.stale && (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
          This report is {duration(v.ageMs / 1000)} old (a cell reports every 60 s): PPS, time and temperature are unknown.
        </p>
      )}
      {v.boardSilent && !v.stale && (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
          The cell says its board is not answering: PPS, time and temperature are unknown.
        </p>
      )}
      <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-slate-500">PPS (GPS time)</dt>
        <dd>
          <StatusDot tone={PPS_TONE[v.pps]} label={ppsLabel(v.pps)} />
        </dd>
        <dt className="text-slate-500">Timebase</dt>
        <dd>{v.timebase === null ? 'unknown' : v.timebase ? 'yes' : 'no'}</dd>
        <dt className="text-slate-500">Temperature</dt>
        <dd className="font-mono">{v.tempC === null ? 'unknown' : `${v.tempC} °C`}</dd>
        <dt className="text-slate-500">Anchor channel</dt>
        <dd className="font-mono">{r.anchor}</dd>
        <dt className="text-slate-500">Board up for</dt>
        <dd>{r.boardUptimeS > 0 ? duration(r.boardUptimeS) : 'unknown'}</dd>
        <dt className="text-slate-500">Reported</dt>
        <dd>
          <When t={r.reportedAt} now={now} />
        </dd>
      </dl>
      <h4 className="text-sm font-semibold">Counters since the cell (or its board) started</h4>
      <dl className="grid max-w-2xl grid-cols-[auto_1fr_auto_1fr] gap-x-6 gap-y-1 text-sm">
        <Counter label="Schedules" value={r.schedules} />
        <Counter label="Schedule misses" value={r.scheduleMisses} warn={r.scheduleMisses > 0} />
        <Counter label="RACH received" value={r.rach} />
        <Counter label="Late slots" value={r.lateSlots} warn={r.lateSlots > 0} />
        <Counter label="Attaches" value={r.attach} />
        <Counter label="Radio errors" value={r.radioErrors > 0 ? `${r.radioErrors} (last ${r.lastRadioError})` : 0} warn={r.radioErrors > 0} />
        <Counter label="Grants sent" value={r.grants} />
        <Counter label="UART CRC errors" value={r.uartCrcErrors} warn={r.uartCrcErrors > 0} />
        <Counter label="ACK errors" value={`${r.ackErrors} (late ${r.ackLate})`} warn={r.ackErrors > 0} />
        <Counter label="Terminals heard" value={r.terminalsHeard} />
      </dl>
    </div>
  );
}

/** The radio section of a cell's page. */
export function RadioPanel({ radio, cellId, online, now }: { radio: Reported<RadioStatus[]> | undefined; cellId: number; online: boolean; now: number }) {
  if (!radio || radio.state === 'unsupported') {
    return <p className="text-sm text-slate-500">Not reported by this core (cell.radio needs oc-core v0.4.0).</p>;
  }
  if (radio.state === 'unreachable') return <p className="text-sm text-red-700 dark:text-red-400">The core did not give its radio reports in time.</p>;
  const mine = radio.value.filter((r) => r.cellId === cellId);
  if (mine.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        {online
          ? 'This cell has not reported its radio yet (oc-cell before v0.1.2 does not; a cell reports within a minute of linking).'
          : 'Not linked: the core has no radio report for it.'}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {mine.map((r) => (
        <OneRadio key={r.radio} r={r} now={now} />
      ))}
    </div>
  );
}
