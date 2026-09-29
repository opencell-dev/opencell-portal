// Which address a request came from. nginx-proxy (OC_TRUSTED_PROXY) is the
// only peer whose X-Forwarded-* headers are believed (portal spec §9).
import { isIP } from 'node:net';

/** @param {string | undefined} a */
function normalize(a) {
  if (!a) return '';
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : '';
  return v4 && isIP(v4) === 4 ? v4 : a;
}

/**
 * @param {string | undefined} peer the socket's remote address
 * @param {string | string[] | undefined} xff the X-Forwarded-For header
 * @param {string} trustedProxy the proxy's address, or '' for none
 */
export function clientIp(peer, xff, trustedProxy) {
  const p = normalize(peer);
  if (trustedProxy && p === trustedProxy && typeof xff === 'string') {
    const last = normalize(xff.split(',').map((s) => s.trim()).filter(Boolean).at(-1));
    if (last && isIP(last)) return last;
  }
  return p || 'unknown';
}

/**
 * @param {string | undefined} peer
 * @param {string} trustedProxy
 */
export function forwardedHeadersTrusted(peer, trustedProxy) {
  return Boolean(trustedProxy) && normalize(peer) === trustedProxy;
}

/**
 * Validate and normalize OC_TRUSTED_PROXY at startup. An unusable value is
 * refused rather than silently falling back to "no proxy trusted": that
 * fallback is safe, but a typo'd address should stop the process, not run
 * with client IPs quietly wrong.
 * @param {string | undefined} value
 * @returns {string} the normalized address, or '' if none was configured
 */
export function parseTrustedProxy(value) {
  if (!value) return '';
  const n = normalize(value);
  if (!isIP(n)) throw new Error(`OC_TRUSTED_PROXY is not a valid IP address: ${JSON.stringify(value)}`);
  return n;
}
