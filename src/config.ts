import { z } from 'zod';

/** HOST:PORT, the port 1–65535 (no IPv6 literal). */
function addrOk(v: string): boolean {
  const m = /^([^\s:]+):(\d{1,5})$/.exec(v);
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 65535;
}

const envSchema = z
  .object({
    OC_ORIGIN: z.url({ protocol: /^https?$/ }),
    OC_RP_ID: z.string().min(1),
    OC_SECRET: z.string().min(32, 'OC_SECRET must be at least 32 characters'),
    OC_DB_PATH: z.string().min(1).default('./data/portal.db'),
    OC_CORE: z.enum(['fake', 'tls'], { error: 'OC_CORE is "fake" or "tls"' }).default('fake'),
    // OC_CORE=tls: the cores' admin API (portal spec §7). One core:
    // OC_CORE_ADDR (+ OC_CORE_NAME). Several (plan P4b): OC_CORES=core1,core2
    // and OC_CORE_<ID>_ADDR / OC_CORE_<ID>_NAME per core (readCores below).
    // The files are shared by every core (one OpenCell root, one portal
    // certificate pinned on each): paths, or (no '/') systemd credentials.
    OC_CORE_ADDR: z.string().refine(addrOk, 'OC_CORE_ADDR is HOST:PORT, e.g. 10.0.0.60:7444').optional(),
    OC_CORE_NAME: z.string().min(1).optional(),
    OC_CORES: z.string().optional(),
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
      for (const k of ['OC_CORE_CA', 'OC_CORE_CERT', 'OC_CORE_KEY'] as const) {
        if (!env[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when OC_CORE=tls` });
      }
      if (env.OC_CORES === undefined && !env.OC_CORE_ADDR) {
        const message = 'OC_CORE_ADDR is required when OC_CORE=tls (or list the cores in OC_CORES)';
        ctx.addIssue({ code: 'custom', path: ['OC_CORE_ADDR'], message });
      }
    }
    if (env.OC_MAIL === 'smtp') {
      for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_TOKEN'] as const) {
        if (!env[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when OC_MAIL=smtp` });
      }
    }
  });

type Env = z.infer<typeof envSchema>;

/** One core's admin API (portal spec §7): where it listens, the name its certificate carries, the shared TLS files. */
export interface CoreEndpoint {
  /** core1, core2, … (OC_CORES; a single OC_CORE_ADDR core is core1). */
  id: string;
  host: string;
  port: number;
  servername: string;
  ca: string;
  cert: string;
  key: string;
}

const CORE_ID = /^[a-z][a-z0-9]{0,15}$/;
const PER_CORE = /^OC_CORE_([A-Z0-9]+)_(ADDR|NAME)$/;

function endpoint(id: string, addr: string, servername: string, e: Env): CoreEndpoint {
  const at = addr.lastIndexOf(':');
  return {
    id,
    host: addr.slice(0, at),
    port: Number(addr.slice(at + 1)),
    servername,
    ca: e.OC_CORE_CA!,
    cert: e.OC_CORE_CERT!,
    key: e.OC_CORE_KEY!,
  };
}

/**
 * The cores, in order (OC_CORE=tls; none for the fake core). The first one
 * takes every number and subscriber operation until P5 routes each block to
 * its home core (portal spec §4.3, §12); the admin dashboard shows them all.
 * Problems go to `issues` as `KEY: message` lines.
 */
function readCores(e: Env, env: Record<string, string | undefined>, issues: string[]): CoreEndpoint[] {
  const listed = e.OC_CORES === undefined ? undefined : e.OC_CORES.split(',').map((s) => s.trim());
  // A per-core key for a core not listed is a typo that would hide a core.
  for (const k of Object.keys(env).sort()) {
    const m = PER_CORE.exec(k);
    if (m && env[k] !== undefined && !listed?.some((id) => id.toUpperCase() === m[1])) {
      issues.push(`${k}: ${m[1].toLowerCase()} is not in OC_CORES`);
    }
  }
  if (e.OC_CORE !== 'tls') {
    if (listed) issues.push('OC_CORES: several cores need OC_CORE=tls');
    return [];
  }
  if (!listed) return [endpoint('core1', e.OC_CORE_ADDR!, e.OC_CORE_NAME ?? 'core1.opencell.k4ozi.com', e)];
  for (const k of ['OC_CORE_ADDR', 'OC_CORE_NAME'] as const) {
    if (e[k] !== undefined) issues.push(`${k}: with OC_CORES, each core has its own OC_CORE_<ID>_ADDR and _NAME`);
  }
  const out: CoreEndpoint[] = [];
  const seen = new Set<string>();
  for (const id of listed) {
    if (!CORE_ID.test(id)) {
      issues.push(`OC_CORES: '${id}' is not a core id (a–z and 0–9, starting with a letter, at most 16)`);
      continue;
    }
    if (seen.has(id)) {
      issues.push(`OC_CORES: ${id} is listed twice`);
      continue;
    }
    seen.add(id);
    const p = `OC_CORE_${id.toUpperCase()}_`;
    const addr = env[`${p}ADDR`];
    const name = env[`${p}NAME`];
    const ok = addr !== undefined && addrOk(addr);
    if (!ok) issues.push(`${p}ADDR: ${p}ADDR is HOST:PORT, e.g. 10.99.0.2:7444`);
    if (!name) issues.push(`${p}NAME: ${p}NAME is required (the name ${id}'s certificate carries)`);
    if (ok && name) out.push(endpoint(id, addr, name, e));
  }
  return out;
}

export type Config = {
  origin: string;
  rpId: string;
  secret: string;
  dbPath: string;
  core: 'fake' | 'tls';
  /** OC_CORE=tls: one or more, the first takes the number and subscriber operations; the fake core: none. */
  cores: CoreEndpoint[];
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
  const lines = r.success ? [] : r.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
  const cores = r.success ? readCores(r.data, env, lines) : [];
  if (!r.success || lines.length > 0) {
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
    cores,
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
