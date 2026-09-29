import { describe, expect, it } from 'vitest';
import { clientIp, forwardedHeadersTrusted, parseTrustedProxy } from '../../server/client-ip.mjs';

const PROXY = '10.0.0.2';

describe('clientIp (X-Forwarded-For only from nginx-proxy, spec §9)', () => {
  it('uses the socket peer when it is not the proxy, whatever the header says', () => {
    expect(clientIp('192.0.2.7', '203.0.113.9', PROXY)).toBe('192.0.2.7');
    expect(clientIp('::ffff:192.0.2.7', undefined, PROXY)).toBe('192.0.2.7');
  });

  it('uses the last X-Forwarded-For entry when the peer is the proxy', () => {
    expect(clientIp('10.0.0.2', '198.51.100.1, 203.0.113.9', PROXY)).toBe('203.0.113.9');
    expect(clientIp('::ffff:10.0.0.2', '2001:db8::5', PROXY)).toBe('2001:db8::5');
  });

  it('falls back to the peer when the proxy sends nothing usable', () => {
    expect(clientIp('10.0.0.2', undefined, PROXY)).toBe('10.0.0.2');
    expect(clientIp('10.0.0.2', 'not-an-ip', PROXY)).toBe('10.0.0.2');
    expect(clientIp('10.0.0.2', ['203.0.113.9'], PROXY)).toBe('10.0.0.2');
  });

  it('trusts no header when no proxy is configured', () => {
    expect(clientIp('10.0.0.2', '203.0.113.9', '')).toBe('10.0.0.2');
    expect(clientIp(undefined, undefined, '')).toBe('unknown');
  });

  it('keeps X-Forwarded-Host and -Proto only from the proxy', () => {
    expect(forwardedHeadersTrusted('10.0.0.2', PROXY)).toBe(true);
    expect(forwardedHeadersTrusted('::ffff:10.0.0.2', PROXY)).toBe(true);
    expect(forwardedHeadersTrusted('192.0.2.7', PROXY)).toBe(false);
    expect(forwardedHeadersTrusted('10.0.0.2', '')).toBe(false);
  });
});

describe('parseTrustedProxy (startup validation of OC_TRUSTED_PROXY)', () => {
  it('accepts no proxy configured', () => {
    expect(parseTrustedProxy(undefined)).toBe('');
    expect(parseTrustedProxy('')).toBe('');
  });

  it('accepts a valid address, normalizing an IPv4-mapped ::ffff: form', () => {
    expect(parseTrustedProxy('10.0.0.2')).toBe('10.0.0.2');
    expect(parseTrustedProxy('::ffff:10.0.0.2')).toBe('10.0.0.2');
    expect(parseTrustedProxy('2001:db8::1')).toBe('2001:db8::1');
  });

  it('refuses to start with an unusable value instead of silently trusting nothing', () => {
    expect(() => parseTrustedProxy('not-an-ip')).toThrow(/OC_TRUSTED_PROXY/);
    expect(() => parseTrustedProxy('10.0.0.2, 10.0.0.3')).toThrow(/OC_TRUSTED_PROXY/);
    expect(() => parseTrustedProxy('10.0.0.2/24')).toThrow(/OC_TRUSTED_PROXY/);
  });
});
