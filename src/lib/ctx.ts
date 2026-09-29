import { type Config, config } from '@/config';
import { getCore } from '@/core';
import type { CoreAdmin } from '@/core/types';
import { type Db, openDb } from '@/db';
import { createMailer, type Mailer } from '@/lib/mail';

/** Everything a service function needs. Tests build their own (tests/helpers/ctx.ts). */
export interface Ctx {
  config: Config;
  db: Db;
  mailer: Mailer;
  core: CoreAdmin;
  now: () => number;
}

const g = globalThis as typeof globalThis & { __ocCtx?: Ctx };

/** The process's context: one database connection, the configured mailer and core. */
export function appCtx(): Ctx {
  if (!g.__ocCtx) {
    const c = config();
    g.__ocCtx = { config: c, db: openDb(c.dbPath), mailer: createMailer(c.mail), core: getCore(), now: Date.now };
  }
  return g.__ocCtx;
}
