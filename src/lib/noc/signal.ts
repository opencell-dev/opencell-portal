// A terminal's signal as its cell last heard it (reg.list, plan N2a).
// CELL_STATUS carries RSSI and SNR, not the tier a terminal uses, so the
// NOC shows the tier its SNR would carry, as an estimate (decision N2a-9):
// LoRa demodulates down to -7.5 dB SNR at SF7 (edge) and -2.5 dB at SF5
// (mid); FLRC (near) wants about +10 dB.

export type SignalTier = 'near' | 'mid' | 'edge' | 'below edge';

export function tierFor(snrDb: number | null): SignalTier | null {
  if (snrDb === null) return null;
  if (snrDb >= 10) return 'near';
  if (snrDb >= -2.5) return 'mid';
  if (snrDb >= -7.5) return 'edge';
  return 'below edge';
}

/** "-61 dBm", "9.5 dB", or "—". */
export function dbm(v: number | null): string {
  return v === null ? '—' : `${v} dBm`;
}

export function db(v: number | null): string {
  return v === null ? '—' : `${v} dB`;
}
