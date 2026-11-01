import type { PpsState, RadioStatus } from '@/core/types';

// How the NOC reads a cell's radio report (NOC design §7.3, plan N2a). A
// cell reports every 60 s and at once when PPS or its timebase changes, so
// a report older than RADIO_STALE_MS means the cell (or its link) stopped
// reporting: what the report says about time and temperature is then
// unknown, not "as last reported". A board that went silent is reported by
// oc-cell as PPS 0, no timebase and temperature -128 (its review I2): also
// unknown. The counters are since the cell's boot; rates need history (N2).

export const RADIO_STALE_MS = 150_000;

export interface RadioView {
  /** The report is older than RADIO_STALE_MS. */
  stale: boolean;
  /** The cell says its board is not answering (PPS 0, no timebase, no temperature). */
  boardSilent: boolean;
  pps: PpsState | 'unknown';
  timebase: boolean | null;
  tempC: number | null;
  ageMs: number;
}

export function radioView(r: RadioStatus, now: number): RadioView {
  const ageMs = Math.max(0, now - r.reportedAt);
  const stale = ageMs > RADIO_STALE_MS;
  const boardSilent = r.pps === 'unlocked' && !r.timebase && r.tempC === null;
  const known = !stale && !boardSilent;
  return { stale, boardSilent, pps: known ? r.pps : 'unknown', timebase: known ? r.timebase : null, tempC: known ? r.tempC : null, ageMs };
}

export function ppsLabel(p: PpsState | 'unknown'): string {
  return p === 'locked' ? 'locked' : p === 'holdover' ? 'holdover' : p === 'unlocked' ? 'unlocked' : 'unknown';
}
