import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMailer, smtpTransportOptions } from '@/lib/mail';
import { magicLinkMail, verifyMail } from '@/lib/mail-templates';

describe('mail', () => {
  it('uses STARTTLS on 587 with the token as the password', () => {
    expect(
      smtpTransportOptions({ host: 'smtp.protonmail.ch', port: 587, user: 'opencell@k4ozi.com', token: 'tok' }),
    ).toEqual({
      host: 'smtp.protonmail.ch',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'opencell@k4ozi.com', pass: 'tok' },
      tls: { minVersion: 'TLSv1.2', servername: 'smtp.protonmail.ch' },
    });
  });

  it('writes each message to the outbox as JSON (development and e2e tests)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocp-mail-'));
    const mailer = createMailer({ transport: 'outbox', outbox: dir, from: 'OpenCell <opencell@k4ozi.com>' });
    await mailer.send({ to: 'a@example.org', subject: 'Hello', text: 'Line one\nhttps://x/y' });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const m = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    expect(m.to).toEqual([{ address: 'a@example.org', name: '' }]);
    expect(m.from).toEqual({ address: 'opencell@k4ozi.com', name: 'OpenCell' });
    expect(m.subject).toBe('Hello');
    expect(m.text).toBe('Line one\nhttps://x/y');
  });

  it('writes the link and its lifetime into the templates', () => {
    const v = verifyMail('https://opencell.k4ozi.com/auth/email/abc');
    expect(v.subject).toBe('Confirm your email for OpenCell');
    expect(v.text).toContain('https://opencell.k4ozi.com/auth/email/abc');
    expect(v.text).toContain('30 minutes');
    const m = magicLinkMail('Ada', 'https://opencell.k4ozi.com/auth/email/def');
    expect(m.text).toContain('15 minutes');
    expect(m.text).toContain('only once');
  });
});
