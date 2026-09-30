import { config } from '@/config';
import { FakeCore } from './fake';
import { TlsCore } from './tls-client';
import type { CoreAdmin } from './types';

export { CoreError } from './types';
export type { CoreAdmin } from './types';

const g = globalThis as typeof globalThis & { __ocCore?: CoreAdmin };

/**
 * The core admin API client for this process: the in-process fake core
 * (OC_CORE=fake, development and tests) or the real core over mTLS
 * (OC_CORE=tls). Made once; TlsCore connects on its first call.
 */
export function getCore(): CoreAdmin {
  const c = config();
  g.__ocCore ??= c.core === 'tls' && c.coreTls ? new TlsCore(c.coreTls) : new FakeCore();
  return g.__ocCore;
}
