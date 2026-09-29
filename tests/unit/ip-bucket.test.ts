import { describe, expect, it } from 'vitest';
import { ipBucket } from '@/lib/ratelimit';

// Per-IP rate limits (spec §3) bucket an IPv6 client by its /64: one
// subscriber line usually gets a whole /64, so per-address limits would let
// a single client rotate through 2^64 addresses.
describe('ipBucket', () => {
  it('keeps an IPv4 address whole', () => {
    expect(ipBucket('192.0.2.10')).toBe('192.0.2.10');
    expect(ipBucket('192.0.2.11')).not.toBe(ipBucket('192.0.2.10'));
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 address', () => {
    expect(ipBucket('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(ipBucket('::FFFF:1.2.3.4')).toBe('1.2.3.4');
    expect(ipBucket('::ffff:0102:0304')).toBe('1.2.3.4');
    expect(ipBucket('0:0:0:0:0:ffff:1.2.3.4')).toBe('1.2.3.4');
  });

  it('puts two addresses in the same /64 in one bucket, whatever their spelling', () => {
    const a = ipBucket('2001:db8:1:2::1');
    expect(ipBucket('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(a);
    expect(ipBucket('2001:0DB8:0001:0002:0:0:0:abcd')).toBe(a);
    expect(ipBucket('2001:db8:1:2::1%eth0')).toBe(a);
    expect(a).toBe('2001:db8:1:2::/64');
  });

  it('keeps different /64s apart', () => {
    expect(ipBucket('2001:db8:1:3::1')).not.toBe(ipBucket('2001:db8:1:2::1'));
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
  });

  it('treats a NAT64 address (64:ff9b::/96) as ordinary IPv6, bucketed by /64, not as its IPv4 tail', () => {
    expect(ipBucket('64:ff9b::1.2.3.4')).toBe('64:ff9b:0:0::/64');
    expect(ipBucket('64:ff9b::1.2.3.4')).not.toBe(ipBucket('1.2.3.4'));
    expect(ipBucket('64:ff9b::5.6.7.8')).toBe(ipBucket('64:ff9b::1.2.3.4'));
  });

  it('leaves anything that is not an address as it is (e.g. "unknown")', () => {
    expect(ipBucket('unknown')).toBe('unknown');
    expect(ipBucket('not:an:ip:::')).toBe('not:an:ip:::');
  });
});
