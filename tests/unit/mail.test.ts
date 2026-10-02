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
    const v = verifyMail('https://opencell.k4ozi.com/auth/email/abc', 'https://opencell.k4ozi.com', 'portal');
    expect(v.subject).toBe('Confirm your email for OpenCell');
    expect(v.text).toContain('https://opencell.k4ozi.com/auth/email/abc');
    expect(v.text).toContain('30 minutes');
    expect(v.text).toContain('https://opencell.k4ozi.com\n'); // signed with the mailing site's own origin
    const m = magicLinkMail('Ada', 'https://opencell.k4ozi.com/auth/email/def', 'https://opencell.k4ozi.com', 'portal');
    expect(m.text).toContain('15 minutes');
    expect(m.text).toContain('only once');
  });

  // M4 (final review): an account on the NOC's site comes from
  // oc-portal-admin add, never a sign-up, and its links point at the NOC's
  // own origin, not the portal's.
  it("words the NOC site's mail for staff, not a sign-up, and signs with its own origin", () => {
    const v = verifyMail('https://noc.opencell.k4ozi.com/auth/email/abc', 'https://noc.opencell.k4ozi.com', 'noc');
    expect(v.subject).not.toContain('Confirm your email for OpenCell');
    expect(v.text).not.toContain('signed up');
    expect(v.text).toContain('administrator created a staff account');
    expect(v.text).toContain('https://noc.opencell.k4ozi.com\n');
    const m = magicLinkMail('Nia', 'https://noc.opencell.k4ozi.com/auth/email/def', 'https://noc.opencell.k4ozi.com', 'noc');
    expect(m.text).toContain('sign in to the OpenCell NOC');
    expect(m.text).toContain('https://noc.opencell.k4ozi.com\n');
  });
});
