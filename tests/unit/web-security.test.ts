import { describe, expect, it } from 'vitest';
import { buildCsp, originAllowed, securityHeaders } from '@/lib/web-security';

describe('CSP (spec §10)', () => {
  it('allows only this origin, and scripts and styles with the request’s nonce', () => {
    expect(buildCsp('abc', { dev: false, https: true })).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'nonce-abc' 'strict-dynamic'",
        "style-src 'self' 'nonce-abc'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        'upgrade-insecure-requests',
      ].join('; '),
    );
  });

  it('adds eval and the dev socket only in development, and no upgrade on http', () => {
    const dev = buildCsp('abc', { dev: true, https: false });
    expect(dev).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic' 'unsafe-eval'");
    expect(dev).toContain("connect-src 'self' ws:");
    expect(dev).not.toContain('upgrade-insecure-requests');
  });

  it('sends the hardening headers, HSTS only over https', () => {
    const h = Object.fromEntries(securityHeaders(true));
    expect(h).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Strict-Transport-Security': 'max-age=31536000',
    });
    expect(h['Permissions-Policy']).toContain('publickey-credentials-get=(self)');
    expect(Object.fromEntries(securityHeaders(false))['Strict-Transport-Security']).toBeUndefined();
  });
});

describe('originAllowed (CSRF, spec §10)', () => {
  const O = 'https://opencell.k4ozi.com';
  it('accepts only the portal’s own origin', () => {
    expect(originAllowed('https://opencell.k4ozi.com', O)).toBe(true);
    expect(originAllowed('https://evil.example', O)).toBe(false);
    expect(originAllowed('http://opencell.k4ozi.com', O)).toBe(false);
    expect(originAllowed('null', O)).toBe(false);
    expect(originAllowed(null, O)).toBe(false);
  });
});
