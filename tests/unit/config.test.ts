import { describe, expect, it } from 'vitest';
import { parseConfig } from '@/config';

const base = {
  OC_ORIGIN: 'https://opencell.k4ozi.com',
  OC_RP_ID: 'opencell.k4ozi.com',
  OC_SECRET: 'x'.repeat(64),
};

describe('parseConfig', () => {
  it('applies the defaults', () => {
    const c = parseConfig(base);
    expect(c.dbPath).toBe('./data/portal.db');
    expect(c.core).toBe('fake');
    expect(c.mail.transport).toBe('outbox');
    expect(c.mail.from).toBe('OpenCell <opencell@k4ozi.com>');
    expect(c.secureCookies).toBe(true);
    expect(c.sessionCookie).toBe('__Host-oc_session');
  });

  it('uses a plain cookie name on http origins (local development and tests)', () => {
    const c = parseConfig({ ...base, OC_ORIGIN: 'http://localhost:3100', OC_RP_ID: 'localhost' });
    expect(c.secureCookies).toBe(false);
    expect(c.sessionCookie).toBe('oc_session');
  });

  it('refuses a short secret', () => {
    expect(() => parseConfig({ ...base, OC_SECRET: 'short' })).toThrow(/OC_SECRET/);
  });

  it('refuses an RP ID that is not the origin host or a parent of it', () => {
    expect(() => parseConfig({ ...base, OC_RP_ID: 'example.com' })).toThrow(/OC_RP_ID/);
    expect(parseConfig({ ...base, OC_RP_ID: 'k4ozi.com' }).rpId).toBe('k4ozi.com');
  });

  it('needs every SMTP setting when mail goes through SMTP', () => {
    expect(() => parseConfig({ ...base, OC_MAIL: 'smtp' })).toThrow(/SMTP_HOST/);
    const c = parseConfig({
      ...base,
      OC_MAIL: 'smtp',
      SMTP_HOST: 'smtp.protonmail.ch',
      SMTP_PORT: '587',
      SMTP_USER: 'opencell@k4ozi.com',
      SMTP_TOKEN: 'tok',
    });
    expect(c.mail.smtp).toEqual({
      host: 'smtp.protonmail.ch',
      port: 587,
      user: 'opencell@k4ozi.com',
      token: 'tok',
    });
  });

  it('refuses any core but the fake one until P4', () => {
    expect(() => parseConfig({ ...base, OC_CORE: 'mtls' })).toThrow(/OC_CORE/);
  });
});
