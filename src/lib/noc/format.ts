import type { CellMode } from '@/core/types';

// How the NOC writes times and identifiers (NOC design §9): relative times
// with the exact UTC time beside them (a title), short fingerprints.

/** "just now", "42 s ago", "5 min ago", "3 h ago", "2 d ago"; "in the future" for a clock ahead. */
export function ago(t: number, now: number): string {
  const s = Math.floor((now - t) / 1000);
  if (s < 0) return 'in the future';
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** "2026-10-01 04:12:09 UTC". */
export function exact(t: number): string {
  return `${new Date(t).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** "42 s", "5 min", "3 h 12 min", "4 d 3 h". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

/** The first 8 and last 4 hex digits of a SHA-256 fingerprint: "ab12cd34…9f0e". */
export function shortFpr(fpr: string): string {
  return fpr.length <= 12 ? fpr : `${fpr.slice(0, 8)}…${fpr.slice(-4)}`;
}

export function modeLabel(m: CellMode): string {
  return m === 'part97' ? 'Part 97' : 'Part 15';
}

/** "+883-1-717-464-12345", numbering v2's display form (its §7, decision 7), or the number as it is. */
export function groupNumber(n: string): string {
  const m = /^\+883(1)(\d{3})(\d{3})(\d{5})$/.exec(n);
  return m ? `+883-${m[1]}-${m[2]}-${m[3]}-${m[4]}` : n;
}
