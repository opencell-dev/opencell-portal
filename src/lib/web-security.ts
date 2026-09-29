// Response hardening (portal spec §10): a strict nonce-based CSP, the usual
// headers, and the origin check for every state-changing request.

export function buildCsp(nonce: string, o: { dev: boolean; https: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${o.dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${o.dev ? ' ws:' : ''}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(o.https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function securityHeaders(https: boolean): [string, string][] {
  const h: [string, string][] = [
    ['X-Content-Type-Options', 'nosniff'],
    // 'no-referrer' makes Chromium send Origin: null on a same-origin HTML
    // form POST, which our own origin check would then reject — breaking the
    // portal's own no-JS forms. same-origin keeps the referrer off the wire
    // to any other site while still telling the browser this is same-origin.
    ['Referrer-Policy', 'same-origin'],
    ['X-Frame-Options', 'DENY'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['Cross-Origin-Resource-Policy', 'same-origin'],
    [
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
    ],
  ];
  if (https) h.push(['Strict-Transport-Security', 'max-age=31536000']);
  return h;
}

/** A state-changing request must carry this portal's exact Origin. */
export function originAllowed(origin: string | null, expected: string): boolean {
  return origin !== null && origin === expected;
}
