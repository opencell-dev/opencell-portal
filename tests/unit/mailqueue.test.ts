import { describe, expect, it, vi } from 'vitest';
import type { Mail, Mailer } from '@/lib/mail';
import { createMailQueue } from '@/lib/mailqueue';

describe('mail queue (spec §3, §10 — no PII in logs)', () => {
  it('does not log the recipient address when a send fails twice', async () => {
    const to = 'ada@example.org';
    const failing: Mailer = { send: async () => Promise.reject(new Error('smtp down')) };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const q = createMailQueue(failing);
      q.send({ to, subject: 's', text: 't' } as Mail);
      await q.drain();
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = spy.mock.calls[0].join(' ');
      expect(logged).not.toContain(to);
    } finally {
      spy.mockRestore();
    }
  });
});
