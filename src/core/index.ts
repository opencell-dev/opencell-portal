import { config } from '@/config';
import { FakeCore } from './fake';
import type { CoreAdmin } from './types';

export { CoreError } from './types';
export type { CoreAdmin } from './types';

const g = globalThis as typeof globalThis & { __ocFakeCore?: FakeCore };

/** The core admin API client for this process (P1: the fake core, `OC_CORE=fake`). */
export function getCore(): CoreAdmin {
  if (config().core !== 'fake') throw new Error('only OC_CORE=fake exists before P4');
  g.__ocFakeCore ??= new FakeCore();
  return g.__ocFakeCore;
}
