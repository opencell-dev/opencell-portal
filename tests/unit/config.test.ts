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

  it('takes the fake core or the real one over TLS, nothing else', () => {
    expect(() => parseConfig({ ...base, OC_CORE: 'mtls' })).toThrow(/OC_CORE/);
    expect(parseConfig(base).cores).toEqual([]);
  });

  it('needs the core address and TLS files for OC_CORE=tls', () => {
    expect(() => parseConfig({ ...base, OC_CORE: 'tls' })).toThrow(/OC_CORE_ADDR/);
    const tls = {
      ...base,
      OC_CORE: 'tls',
      OC_CORE_ADDR: '10.0.0.60:7444',
      OC_CORE_CA: '/etc/opencell/tls/ca.crt',
      OC_CORE_CERT: 'portal.crt',
      OC_CORE_KEY: 'portal.key',
    };
    expect(() => parseConfig({ ...tls, OC_CORE_KEY: undefined })).toThrow(/OC_CORE_KEY/);
    expect(() => parseConfig({ ...tls, OC_CORE_ADDR: '10.0.0.60' })).toThrow(/OC_CORE_ADDR/);
    const c = parseConfig(tls);
    expect(c.core).toBe('tls');
    // Today's single-core environment is one core, core1 (P4b: backward compatible).
    expect(c.cores).toEqual([
      {
        id: 'core1',
        host: '10.0.0.60',
        port: 7444,
        servername: 'core1.opencell.k4ozi.com',
        ca: '/etc/opencell/tls/ca.crt',
        cert: 'portal.crt',
        key: 'portal.key',
      },
    ]);
    expect(parseConfig({ ...tls, OC_CORE_NAME: 'other.example' }).cores[0].servername).toBe('other.example');
  });
});

describe('parseConfig: several cores (OC_CORES, plan P4b)', () => {
  const files = {
    ...base,
    OC_CORE: 'tls',
    OC_CORE_CA: 'core-ca.crt',
    OC_CORE_CERT: 'core-client.crt',
    OC_CORE_KEY: 'core-client.key',
  };
  const two = {
    ...files,
    OC_CORES: 'core1,core2',
    OC_CORE_CORE1_ADDR: '10.0.0.60:7444',
    OC_CORE_CORE1_NAME: 'core1.opencell.k4ozi.com',
    OC_CORE_CORE2_ADDR: '10.99.0.2:7444',
    OC_CORE_CORE2_NAME: 'core2.opencell.k4ozi.com',
  };

  it('lists the cores in OC_CORES order, each with its address and name, sharing the TLS files', () => {
    const c = parseConfig(two);
    expect(c.cores.map((e) => [e.id, e.host, e.port, e.servername])).toEqual([
      ['core1', '10.0.0.60', 7444, 'core1.opencell.k4ozi.com'],
      ['core2', '10.99.0.2', 7444, 'core2.opencell.k4ozi.com'],
    ]);
    for (const e of c.cores) expect([e.ca, e.cert, e.key]).toEqual(['core-ca.crt', 'core-client.crt', 'core-client.key']);
  });

  it("needs each listed core's address and name", () => {
    expect(() => parseConfig({ ...two, OC_CORE_CORE2_ADDR: undefined })).toThrow(/OC_CORE_CORE2_ADDR/);
    expect(() => parseConfig({ ...two, OC_CORE_CORE2_ADDR: '10.99.0.2' })).toThrow(/OC_CORE_CORE2_ADDR/);
    expect(() => parseConfig({ ...two, OC_CORE_CORE2_ADDR: '10.99.0.2:70000' })).toThrow(/OC_CORE_CORE2_ADDR/);
    expect(() => parseConfig({ ...two, OC_CORE_CORE2_NAME: undefined })).toThrow(/OC_CORE_CORE2_NAME/);
  });

  it('refuses a bad or repeated core id', () => {
    expect(() => parseConfig({ ...two, OC_CORES: 'core1,Core-2' })).toThrow(/OC_CORES/);
    expect(() => parseConfig({ ...two, OC_CORES: 'core1,core1' })).toThrow(/listed twice/);
    expect(() => parseConfig({ ...two, OC_CORES: 'core1,' })).toThrow(/OC_CORES/);
  });

  it('refuses a per-core setting for a core not in OC_CORES (a typo would hide a core)', () => {
    expect(() => parseConfig({ ...two, OC_CORE_CORE3_ADDR: '10.99.0.3:7444' })).toThrow(
      /OC_CORE_CORE3_ADDR: core3 is not in OC_CORES/,
    );
    expect(() => parseConfig({ ...files, OC_CORE_ADDR: '10.0.0.60:7444', OC_CORE_CORE2_NAME: 'x' })).toThrow(
      /OC_CORE_CORE2_NAME/,
    );
  });

  it('also refuses an underscored or lowercase typo in an unlisted core key (review M1)', () => {
    // core3 was forgotten in OC_CORES; a typo'd key must still be refused,
    // not silently dropped, even when the typo itself isn't all-caps A-Z0-9.
    expect(() => parseConfig({ ...two, OC_CORE_CORE_3_ADDR: '10.99.0.3:7444' })).toThrow(
      /OC_CORE_CORE_3_ADDR: core_3 is not in OC_CORES/,
    );
    expect(() => parseConfig({ ...two, OC_CORE_core3_ADDR: '10.99.0.3:7444' })).toThrow(
      /OC_CORE_core3_ADDR: core3 is not in OC_CORES/,
    );
  });

  it('refuses the single-core OC_CORE_ADDR or OC_CORE_NAME beside OC_CORES', () => {
    expect(() => parseConfig({ ...two, OC_CORE_ADDR: '10.0.0.60:7444' })).toThrow(/OC_CORE_ADDR/);
    expect(() => parseConfig({ ...two, OC_CORE_NAME: 'core1.opencell.k4ozi.com' })).toThrow(/OC_CORE_NAME/);
  });

  it('refuses OC_CORES with the fake core', () => {
    expect(() => parseConfig({ ...base, OC_CORES: 'core1' })).toThrow(/OC_CORES.*OC_CORE=tls/);
  });
});
