import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicMessage, UserError } from '@/lib/errors';

afterEach(() => vi.restoreAllMocks());

describe('publicMessage', () => {
  it('passes a UserError’s message through, without logging it', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(publicMessage(new UserError('Only a verified account can add a passkey.'), 'x')).toBe(
      'Only a verified account can add a passkey.',
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('hides anything else behind the fallback and logs it server-side', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('SQLITE_BUSY: database is locked at /srv/portal.db');
    expect(publicMessage(boom, 'Something went wrong. Please try again.')).toBe('Something went wrong. Please try again.');
    expect(publicMessage('a string', 'fallback')).toBe('fallback');
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]).toContain(boom);
  });
});
