import { type Config, config } from '@/config';
import { FakeCore } from './fake';
import { seedDemo } from './fake-demo';
import { TlsCore } from './tls-client';
import type { CoreAdmin, CoreHandle } from './types';

export { CoreError } from './types';
export type { CoreAdmin, CoreHandle } from './types';

const g = globalThis as typeof globalThis & { __ocCores?: CoreHandle[] };

/** A core's number on the network: core<N> → N, else its position + 1. */
function coreNoOf(id: string, position: number): number {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : position + 1;
}

/**
 * The cores of a configuration, in order: one TlsCore per core
 * (OC_CORE=tls: OC_CORE_ADDR's one, or OC_CORES's), or the in-process fake
 * cores (OC_CORE=fake, development and tests): fake, fake2, … as
 * OC_FAKE_CORES says, each with the demo network when OC_FAKE_DEMO=1 (NOC
 * design §10). None connects yet: each TlsCore connects on its first call.
 */
export function makeCores(c: Config): CoreHandle[] {
  if (c.core === 'tls') return c.cores.map((e, i) => ({ id: e.id, where: `${e.host}:${e.port}`, coreNo: coreNoOf(e.id, i), ...(e.cellAddr ? { cellAddr: e.cellAddr } : {}), core: new TlsCore(e) }));
  return Array.from({ length: c.fake.cores }, (_, i) => {
    const core = new FakeCore(Date.now, { coreId: i + 1, name: i === 0 ? 'fake-core' : `fake-core-${i + 1}` });
    if (c.fake.demo) seedDemo(core, i, Date.now(), c.fake.cores);
    return { id: i === 0 ? 'fake' : `fake${i + 1}`, where: 'in-process', coreNo: i + 1, cellAddr: 'cells.fake.invalid:7443', core };
  });
}

/** This process's cores, made once (one connection per core). */
export function getCores(): CoreHandle[] {
  g.__ocCores ??= makeCores(config());
  return g.__ocCores;
}

/**
 * The first of OC_CORES. Number and subscriber operations don't use it: they
 * pick the number's home core with coreFor (lib/numbers/route.ts).
 */
export function getCore(): CoreAdmin {
  return getCores()[0].core;
}
