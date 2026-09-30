import { z } from 'zod';

const envSchema = z
  .object({
    OC_ORIGIN: z.url({ protocol: /^https?$/ }),
    OC_RP_ID: z.string().min(1),
    OC_SECRET: z.string().min(32, 'OC_SECRET must be at least 32 characters'),
    OC_DB_PATH: z.string().min(1).default('./data/portal.db'),
    OC_CORE: z.enum(['fake', 'tls'], { error: 'OC_CORE is "fake" or "tls"' }).default('fake'),
    // OC_CORE=tls: the core's admin API (portal spec §7). The files are
    // paths, or (no '/') systemd credentials by name.
    OC_CORE_ADDR: z
      .string()
      .regex(/^[^\s:]+:\d{1,5}$/, 'OC_CORE_ADDR is HOST:PORT, e.g. 10.0.0.60:7444')
      .optional(),
    OC_CORE_NAME: z.string().min(1).default('core1.opencell.k4ozi.com'),
    OC_CORE_CA: z.string().min(1).optional(),
    OC_CORE_CERT: z.string().min(1).optional(),
    OC_CORE_KEY: z.string().min(1).optional(),
    OC_MAIL: z.enum(['smtp', 'outbox']).default('outbox'),
    OC_MAIL_OUTBOX: z.string().min(1).default('./data/outbox'),
    OC_MAIL_FROM: z.string().min(3).default('OpenCell <opencell@k4ozi.com>'),
    OC_ALTCHA_COST: z.coerce.number().int().min(1).default(2000),
    OC_ALTCHA_COUNTER_MAX: z.coerce.number().int().min(2).default(2000),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const host = new URL(env.OC_ORIGIN).hostname;
    if (host !== env.OC_RP_ID && !host.endsWith(`.${env.OC_RP_ID}`)) {
      ctx.addIssue({ code: 'custom', path: ['OC_RP_ID'], message: 'OC_RP_ID must be the origin host or a parent domain of it' });
    }
    if (env.OC_CORE === 'tls') {
      for (const k of ['OC_CORE_ADDR', 'OC_CORE_CA', 'OC_CORE_CERT', 'OC_CORE_KEY'] as const) {
        if (!env[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when OC_CORE=tls` });
      }
    }
    if (env.OC_MAIL === 'smtp') {
      for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_TOKEN'] as const) {
        if (!env[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when OC_MAIL=smtp` });
      }
    }
  });

export type Config = {
  origin: string;
  rpId: string;
  secret: string;
  dbPath: string;
  core: 'fake' | 'tls';
  /** OC_CORE=tls only. */
  coreTls?: { host: string; port: number; servername: string; ca: string; cert: string; key: string };
  secureCookies: boolean;
  sessionCookie: string;
  mail: {
    transport: 'smtp' | 'outbox';
    outbox: string;
    from: string;
    smtp?: { host: string; port: number; user: string; token: string };
  };
  altcha: { cost: number; counterMax: number };
};

export function parseConfig(env: Record<string, string | undefined>): Config {
  const r = envSchema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`Invalid portal configuration:\n${lines.join('\n')}`);
  }
  const e = r.data;
  const origin = new URL(e.OC_ORIGIN).origin;
  const secure = origin.startsWith('https:');
  return {
    origin,
    rpId: e.OC_RP_ID,
    secret: e.OC_SECRET,
    dbPath: e.OC_DB_PATH,
    core: e.OC_CORE,
    coreTls:
      e.OC_CORE === 'tls'
        ? {
            host: e.OC_CORE_ADDR!.slice(0, e.OC_CORE_ADDR!.lastIndexOf(':')),
            port: Number(e.OC_CORE_ADDR!.slice(e.OC_CORE_ADDR!.lastIndexOf(':') + 1)),
            servername: e.OC_CORE_NAME,
            ca: e.OC_CORE_CA!,
            cert: e.OC_CORE_CERT!,
            key: e.OC_CORE_KEY!,
          }
        : undefined,
    secureCookies: secure,
    sessionCookie: secure ? '__Host-oc_session' : 'oc_session',
    mail: {
      transport: e.OC_MAIL,
      outbox: e.OC_MAIL_OUTBOX,
      from: e.OC_MAIL_FROM,
      smtp:
        e.OC_MAIL === 'smtp'
          ? { host: e.SMTP_HOST!, port: e.SMTP_PORT!, user: e.SMTP_USER!, token: e.SMTP_TOKEN! }
          : undefined,
    },
    altcha: { cost: e.OC_ALTCHA_COST, counterMax: e.OC_ALTCHA_COUNTER_MAX },
  };
}

let cached: Config | undefined;

/** The process's configuration, read once from the environment. */
export function config(): Config {
  cached ??= parseConfig(process.env);
  return cached;
}
