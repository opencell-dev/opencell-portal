import { parseConfig } from '@/config';
import { FakeCore } from '@/core/fake';
import { openDb } from '@/db';
import type { Ctx } from '@/lib/ctx';
import { MemoryMailer } from '@/lib/mail';
import { createMailQueue } from '@/lib/mailqueue';

export const TEST_ORIGIN = 'https://portal.test';

export type TestCtx = Ctx & { mailer: MemoryMailer; core: FakeCore; clock: { t: number } };

/** A context with an in-memory database, a memory mailer, a fake core and a hand-moved clock. */
export function testCtx(): TestCtx {
  const clock = { t: 1_790_000_000_000 };
  const now = () => clock.t;
  const mailer = new MemoryMailer();
  return {
    config: parseConfig({
      OC_ORIGIN: TEST_ORIGIN,
      OC_RP_ID: 'portal.test',
      OC_SECRET: 'test-secret-test-secret-test-secret-0123',
      OC_ALTCHA_COST: '1',
      OC_ALTCHA_COUNTER_MAX: '20',
    }),
    db: openDb(':memory:'),
    mailer,
    mailQueue: createMailQueue(mailer),
    core: new FakeCore(now),
    now,
    clock,
  };
}
