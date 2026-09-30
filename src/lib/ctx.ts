import { type Config, config } from '@/config';
import { getCore, getCores } from '@/core';
import type { CoreAdmin, CoreHandle } from '@/core/types';
import { type Db, openDb } from '@/db';
import { startHousekeeping } from '@/lib/housekeeping';
import { createMailer, type Mailer } from '@/lib/mail';
import { createMailQueue, type MailQueue } from '@/lib/mailqueue';

/** Everything a service function needs. Tests build their own (tests/helpers/ctx.ts). */
export interface Ctx {
  config: Config;
  db: Db;
  mailer: Mailer;
  mailQueue: MailQueue;
  /** Every number and subscriber operation's core: cores[0] until P5 (the East/West split). */
  core: CoreAdmin;
  /** Every core, in config order (the admin dashboard). */
  cores: CoreHandle[];
  now: () => number;
}

const g = globalThis as typeof globalThis & { __ocCtx?: Ctx };

/** A context from the environment: one database connection, the configured mailer and core. */
export function createCtx(): Ctx {
  const c = config();
  const mailer = createMailer(c.mail);
  return {
    config: c,
    db: openDb(c.dbPath),
    mailer,
    mailQueue: createMailQueue(mailer),
    core: getCore(),
    cores: getCores(),
    now: Date.now,
  };
}

/**
 * The server process's context, built by its first request (the deploy's
 * /healthz check, right after start). Building it also starts housekeeping:
 * purgeStale at once, then hourly (housekeeping.ts). The admin CLI uses
 * createCtx() instead, so a CLI run purges nothing.
 */
export function appCtx(): Ctx {
  if (!g.__ocCtx) {
    g.__ocCtx = createCtx();
    startHousekeeping(g.__ocCtx);
  }
  return g.__ocCtx;
}
