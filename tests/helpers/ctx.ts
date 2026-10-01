import { parseConfig } from '@/config';
import { FakeCore } from '@/core/fake';
import { openDb } from '@/db';
import type { Ctx } from '@/lib/ctx';
import { MemoryMailer } from '@/lib/mail';
import { createMailQueue } from '@/lib/mailqueue';

export const TEST_ORIGIN = 'https://portal.test';

export type TestCtx = Ctx & { mailer: MemoryMailer; core: FakeCore; clock: { t: number } };

/**
 * A context with an in-memory database, a memory mailer, a fake core and a
 * hand-moved clock. `env` adds to or overrides the test configuration, e.g.
 * `{ OC_SITE: 'noc' }` for the NOC's own site.
 */
export function testCtx(env: Record<string, string> = {}): TestCtx {
  const clock = { t: 1_790_000_000_000 };
  const now = () => clock.t;
  const mailer = new MemoryMailer();
  const core = new FakeCore(now);
  return {
    config: parseConfig({
      OC_ORIGIN: TEST_ORIGIN,
      OC_RP_ID: 'portal.test',
      OC_SECRET: 'test-secret-test-secret-test-secret-0123',
      OC_ALTCHA_COST: '1',
      OC_ALTCHA_COUNTER_MAX: '20',
      ...env,
    }),
    db: openDb(':memory:'),
    mailer,
    mailQueue: createMailQueue(mailer),
    core,
    cores: [{ id: 'fake', where: 'in-process', core }],
    now,
    clock,
  };
}
