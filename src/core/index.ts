import { type Config, config } from '@/config';
import { FakeCore } from './fake';
import { TlsCore } from './tls-client';
import type { CoreAdmin, CoreHandle } from './types';

export { CoreError } from './types';
export type { CoreAdmin, CoreHandle } from './types';

const g = globalThis as typeof globalThis & { __ocCores?: CoreHandle[] };

/**
 * The cores of a configuration, in order: one TlsCore per core
 * (OC_CORE=tls: OC_CORE_ADDR's one, or OC_CORES's), or the in-process fake
 * core (OC_CORE=fake, development and tests). None connects yet: each
 * TlsCore connects on its first call.
 */
export function makeCores(c: Config): CoreHandle[] {
  if (c.core === 'tls') return c.cores.map((e) => ({ id: e.id, where: `${e.host}:${e.port}`, core: new TlsCore(e) }));
  return [{ id: 'fake', where: 'in-process', core: new FakeCore() }];
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
