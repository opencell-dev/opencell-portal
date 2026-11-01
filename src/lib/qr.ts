import QRCode from 'qrcode';

/**
 * The activation QR as an inline SVG (portal spec §4.1 step 4), drawn on the
 * server: no script, no data: URL, nothing for the CSP to allow. Error
 * correction M, as a phone screen or a print shows it well enough.
 */
export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
}
