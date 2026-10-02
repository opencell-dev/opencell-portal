import { type Config, config } from '@/config';
import { FakeCore } from './fake';
import { seedDemo } from './fake-demo';
import { TlsCore } from './tls-client';
import type { CoreAdmin, CoreHandle } from './types';

export { CoreError } from './types';
export type { CoreAdmin, CoreHandle } from './types';

const g = globalThis as typeof globalThis & { __ocCores?: CoreHandle[] };

/**
 * The cores of a configuration, in order: one TlsCore per core
 * (OC_CORE=tls: OC_CORE_ADDR's one, or OC_CORES's), or the in-process fake
 * cores (OC_CORE=fake, development and tests): fake, fake2, … as
 * OC_FAKE_CORES says, each with the demo network when OC_FAKE_DEMO=1 (NOC
 * design §10). None connects yet: each TlsCore connects on its first call.
 */
export function makeCores(c: Config): CoreHandle[] {
  if (c.core === 'tls') return c.cores.map((e) => ({ id: e.id, where: `${e.host}:${e.port}`, core: new TlsCore(e) }));
  return Array.from({ length: c.fake.cores }, (_, i) => {
    const core = new FakeCore(Date.now, { coreId: i + 1, name: i === 0 ? 'fake-core' : `fake-core-${i + 1}` });
    if (c.fake.demo) seedDemo(core, i, Date.now());
    return { id: i === 0 ? 'fake' : `fake${i + 1}`, where: 'in-process', core };
  });
}

/** This process's cores, made once (one connection per core). */
export function getCores(): CoreHandle[] {
  g.__ocCores ??= makeCores(config());
  return g.__ocCores;
}

/**
 * The core every number and subscriber operation goes to: the first of
 * OC_CORES (core 1). Until P5 routes each block to its home core (portal
 * spec §4.3, §12), the other cores only show on the admin dashboard.
 */
export function getCore(): CoreAdmin {
  return getCores()[0].core;
}
