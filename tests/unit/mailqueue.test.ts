import { createHash } from 'node:crypto';
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

  it('does not tag the failure with an unkeyed hash of the address (guessable/dictionary-able)', async () => {
    const to = 'ada@example.org';
    const failing: Mailer = { send: async () => Promise.reject(new Error('smtp down')) };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const q = createMailQueue(failing);
      q.send({ to, subject: 's', text: 't' } as Mail);
      q.send({ to, subject: 's', text: 't' } as Mail);
      await q.drain();
      expect(spy).toHaveBeenCalledTimes(2);
      const [first, second] = spy.mock.calls.map((c) => c.join(' '));
      const unkeyedTag = createHash('sha256').update(to).digest('hex').slice(0, 8);
      expect(first).not.toContain(unkeyedTag);
      // Two independent sends to the same address get different (random) tags.
      expect(first).not.toBe(second);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs only the tag and the error class, even when the error carries the address (nodemailer EENVELOPE)', async () => {
    const to = 'zoe.q@mailhost.test';
    // What nodemailer's SMTP connection throws for a rejected recipient.
    const rejected = () =>
      Object.assign(new Error(`Mail command failed: 550 5.1.1 <${to}>: Recipient address rejected`), {
        code: 'EENVELOPE',
        responseCode: 550,
        command: 'RCPT TO',
        response: `550 5.1.1 <${to}>: Recipient address rejected`,
        rejected: [to],
        rejectedErrors: [Object.assign(new Error(`Recipient command failed: <${to}>`), { recipient: to })],
      });
    const failing: Mailer = { send: async () => Promise.reject(rejected()) };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const q = createMailQueue(failing);
      q.send({ to, subject: 's', text: 't' } as Mail);
      await q.drain();
      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0];
      // One plain string: no error object for the console to print in full.
      expect(args).toHaveLength(1);
      expect(typeof args[0]).toBe('string');
      const line = args[0] as string;
      expect(line).toMatch(/^mail to recipient [0-9a-f]{8} failed twice, giving up \(Error EENVELOPE 550\)$/);
      for (const part of [to, 'zoe.q', 'mailhost', encodeURIComponent(to), Buffer.from(to).toString('base64')]) expect(line).not.toContain(part);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs a made-up error code or name as unknown rather than echoing it', async () => {
    const to = 'zoe.q@mailhost.test';
    const odd = Object.assign(new Error('x'), { name: `Bad <${to}>`, code: `E ${to}`, responseCode: to });
    const failing: Mailer = { send: async () => Promise.reject(odd) };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const q = createMailQueue(failing);
      q.send({ to, subject: 's', text: 't' } as Mail);
      await q.drain();
      const line = spy.mock.calls[0][0] as string;
      expect(line).toMatch(/^mail to recipient [0-9a-f]{8} failed twice, giving up \(unknown error\)$/);
    } finally {
      spy.mockRestore();
    }
  });
});
