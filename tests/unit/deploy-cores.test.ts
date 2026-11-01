import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@/config';

// Plan P4b: the portal guest's deploy files for two cores.
const DEPLOY = join(import.meta.dirname, '..', '..', 'deploy');

/** KEY=value lines (comments and blank lines skipped), as systemd's EnvironmentFile reads them. */
function envFile(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(join(DEPLOY, name), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe('the deploy files for two cores', () => {
  it('portal.env.example configures core1 and core2, core1 first', () => {
    // The secret is a placeholder there, and SMTP lives in portal-smtp.env.
    const c = parseConfig({ ...envFile('portal.env.example'), OC_SECRET: 'x'.repeat(64), OC_MAIL: 'outbox' });
    expect(c.cores.map((e) => `${e.id} ${e.host}:${e.port} ${e.servername}`)).toEqual([
      'core1 10.0.0.60:7444 core1.opencell.k4ozi.com',
      'core2 10.99.0.2:7444 core2.opencell.k4ozi.com',
    ]);
    for (const e of c.cores) expect([e.ca, e.cert, e.key]).toEqual(['core-ca.crt', 'core-client.crt', 'core-client.key']);
  });

  it('noc.env.example is the NOC site on its own name, with the same cores, files and listeners (NOC design §N1.5)', () => {
    const portal = envFile('portal.env.example');
    const noc = envFile('noc.env.example');
    const c = parseConfig({ ...noc, OC_SECRET: 'x'.repeat(64), OC_MAIL: 'outbox' });
    expect([c.site, c.origin, c.rpId]).toEqual(['noc', 'https://noc.opencell.k4ozi.com', 'opencell.k4ozi.com']);
    expect(parseConfig({ ...portal, OC_SECRET: 'x'.repeat(64), OC_MAIL: 'outbox' }).site).toBe('portal');
    const differ = Object.keys({ ...portal, ...noc })
      .filter((k) => portal[k] !== noc[k])
      .sort();
    // The NOC site holds no numbers, so it signs none: the delegate key is the portal's alone.
    // Nor nodes (plan P3): the cell intermediate, the cell addresses and the releases are the portal's too.
    expect(differ).toEqual(['OC_CELL_CA_CERT', 'OC_CELL_CA_KEY', 'OC_CORE_CORE1_CELLS', 'OC_CORE_CORE2_CELLS', 'OC_ORIGIN', 'OC_RELEASE_DIR', 'OC_ROUTE_DELEGATE_KEY', 'OC_SITE']);
    expect(noc.OC_CELL_CA_KEY).toBeUndefined();
  });

  it("oc-cores-route.service routes the cores' WireGuard network through oc-core-1", () => {
    const unit = readFileSync(join(DEPLOY, 'oc-cores-route.service'), 'utf8');
    expect(unit).toMatch(/^ExecStart=\/usr\/bin\/ip route replace 10\.99\.0\.0\/24 via 10\.0\.0\.60 dev eth0$/m);
    // Leading '-' (review M7): ExecStop must not fail the unit when the
    // route is already gone (eth0 flapped, or PartOf= already tore it down).
    expect(unit).toMatch(/^ExecStop=-\/usr\/bin\/ip route del 10\.99\.0\.0\/24 via 10\.0\.0\.60 dev eth0$/m);
    expect(unit).toMatch(/^PartOf=networking\.service$/m);
    // Also WantedBy=networking.service (review M8): PartOf= alone only
    // restores the route on stop/restart, not on a plain `start` after
    // `stop`, or after eth0 itself goes down and up.
    expect(unit).toMatch(/^WantedBy=multi-user\.target networking\.service$/m);
  });

  // Plan P5: the weekly refresh talks to the cores and signs with the delegate key.
  const creds = (name: string) => readFileSync(join(DEPLOY, name), 'utf8').split('\n').filter((l) => l.startsWith('LoadCredential='));

  it('oc-portal-nanpa.service has the core TLS credentials portal.env names', () => {
    expect(creds('oc-portal-nanpa.service')).toEqual(creds('oc-portal-core-tls.conf'));
    const env = envFile('portal.env.example');
    const given = creds('oc-portal-nanpa.service').map((l) => l.slice('LoadCredential='.length).split(':')[0]);
    expect(given).toEqual([env.OC_CORE_CA, env.OC_CORE_CERT, env.OC_CORE_KEY]);
  });

  it('the delegate key comes by a drop-in, not the unit: LoadCredential of a missing file fails a unit (243/CREDENTIALS), and a refresh must run without it', () => {
    expect(creds('oc-portal-route-delegate.conf')).toEqual(['LoadCredential=route-delegate.key:/etc/opencell/tls/route-delegate.key']);
    expect(envFile('portal.env.example').OC_ROUTE_DELEGATE_KEY).toBe('route-delegate.key');
    for (const unit of ['oc-portal-nanpa.service', 'oc-portal.service', 'oc-portal-core-tls.conf']) {
      expect(readFileSync(join(DEPLOY, unit), 'utf8')).not.toMatch(/^LoadCredential=route-delegate/m);
    }
  });

  it('oc-portal-admin gives nanpa-refresh the credentials it would have under its timer, and no other command', () => {
    const text = readFileSync(join(DEPLOY, 'oc-portal-admin'), 'utf8');
    expect(text).toContain('[ "${1:-}" = nanpa-refresh ]');
    for (const f of ['ca.crt', 'portal.crt', 'portal.key', 'route-delegate.key']) expect(text).toContain(f);
  });
});
