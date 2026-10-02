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
    expect(differ).toEqual(['OC_ORIGIN', 'OC_SITE']);
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
});
