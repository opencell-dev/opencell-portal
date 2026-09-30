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

  it("oc-cores-route.service routes the cores' WireGuard network through oc-core-1", () => {
    const unit = readFileSync(join(DEPLOY, 'oc-cores-route.service'), 'utf8');
    expect(unit).toMatch(/^ExecStart=\/usr\/bin\/ip route replace 10\.99\.0\.0\/24 via 10\.0\.0\.60 dev eth0$/m);
    expect(unit).toMatch(/^ExecStop=\/usr\/bin\/ip route del 10\.99\.0\.0\/24 via 10\.0\.0\.60 dev eth0$/m);
    expect(unit).toMatch(/^PartOf=networking\.service$/m);
    expect(unit).toMatch(/^WantedBy=multi-user\.target$/m);
  });
});
