import { sql } from 'drizzle-orm';
import { blob, index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Times are unix milliseconds. Ids of users come from AUTOINCREMENT, so a
// deleted account's id is never reused and the audit can keep it.

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerifiedAt: integer('email_verified_at'),
  directoryListed: integer('directory_listed', { mode: 'boolean' }).notNull().default(true),
  numberLimit: integer('number_limit').notNull().default(3),
  createdAt: integer('created_at').notNull(),
});

export const userRoles = sqliteTable(
  'user_roles',
  {
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    // 'noc' (NOC design §4): a value, not a schema change: SQLite keeps the
    // column a plain TEXT with no CHECK, so no migration (drizzle-kit agrees).
    role: text('role', { enum: ['operator', 'noc', 'admin'] }).notNull(),
    grantedAt: integer('granted_at').notNull(),
    grantedBy: integer('granted_by'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);

export const passkeys = sqliteTable(
  'passkeys',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
    counter: integer('counter').notNull(),
    transports: text('transports'),
    deviceType: text('device_type'),
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
    name: text('name').notNull().default('Passkey'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('passkeys_user').on(t.userId)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // SHA-256 of the cookie's token, hex
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    method: text('method', { enum: ['email', 'passkey'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    reauthAt: integer('reauth_at'),
    // Set from the assertion's authenticationInfo.userVerified at sign-in. A
    // passkey session without UV never counts as admin-capable (spec §3).
    uv: integer('uv', { mode: 'boolean' }).notNull().default(false),
    // The passkey that opened this session (no FK: SQLite can't add an
    // ON DELETE action via ALTER TABLE), so removing it can revoke the session.
    credentialId: text('credential_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

export const emailTokens = sqliteTable(
  'email_tokens',
  {
    id: text('id').primaryKey(), // SHA-256 of the link's token, hex
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['verify', 'magic', 'email_change'] }).notNull(),
    newEmail: text('new_email'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [index('email_tokens_user').on(t.userId)],
);

export const challenges = sqliteTable('challenges', {
  id: text('id').primaryKey(),
  purpose: text('purpose', { enum: ['register', 'signin', 'reauth'] }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  // Bound to the session that requested it (null for signin, which has none),
  // so one session can't finish a challenge issued to another (spec §3).
  sessionId: text('session_id'),
  challenge: text('challenge').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const captchaUsed = sqliteTable('captcha_used', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
});

export const rateEvents = sqliteTable(
  'rate_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [index('rate_events_key_at').on(t.key, t.at)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const audit = sqliteTable(
  'audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull().default(sql`(unixepoch() * 1000)`),
    actorId: integer('actor_id'), // no foreign key: the id outlives the account
    action: text('action').notNull(),
    target: text('target'),
    detail: text('detail'),
    ip: text('ip'),
  },
  (t) => [index('audit_at').on(t.at)],
);

// ---- Portal P2: numbers (portal spec §4, §5) ----

/**
 * The numbers an account holds, one row per number. The primary key is the
 * number itself, so a double submit or a second tab can never store it twice.
 * A row is written only after the core's sub.create answered (spec §4.2: the
 * core holds the truth; the portal reflects it). The portal never stores the
 * QR payload, K, OPc, SQN or a token secret (spec §7, §10).
 */
export const numbers = sqliteTable(
  'numbers',
  {
    number: text('number').primaryKey(), // +8831NPANXXSSSSS
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    // The CoreHandle.id that issued it (P5 routes by NPA; this says where it went).
    coreId: text('core_id').notNull(),
    // Per-number directory listing (P2 decision 1); users.directoryListed is the master switch.
    listed: integer('listed', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    // When the terminal it is on now activated it, as the portal first saw it.
    activatedAt: integer('activated_at'),
    tokenExpiresAt: integer('token_expires_at'),
    state: text('state', { enum: ['unactivated', 'activated'] }).notNull(),
    // The last sub.status the portal saw. statusAt: when it last asked, answered
    // or not, so a core that is down or limiting is not asked more often either.
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    registered: integer('registered', { mode: 'boolean' }).notNull().default(false),
    cellId: integer('cell_id'),
    // The core whose cell cellId is (OCSS spec §5.6): cell ids are per core. Null: not registered, or a v0.7.0 core.
    servingCore: integer('serving_core'),
    tmidPrefix: text('tmid_prefix'),
    lastSeenAt: integer('last_seen_at'),
    statusAt: integer('status_at'),
  },
  (t) => [index('numbers_user').on(t.userId)],
);

/** "More numbers, please" (spec §4.2: above 3 an admin raises the account's limit). */
export const limitRequests = sqliteTable(
  'limit_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    wanted: integer('wanted').notNull(),
    createdAt: integer('created_at').notNull(),
    decidedAt: integer('decided_at'),
    decidedBy: integer('decided_by'), // no foreign key: the id outlives the account
    outcome: text('outcome', { enum: ['raised', 'declined'] }),
    note: text('note'),
  },
  (t) => [index('limit_requests_user').on(t.userId)],
);

/** NANPA's NPA list (spec §4.4). Only geographic NPAs with a known region are offered. */
export const npas = sqliteTable('npas', {
  npa: text('npa').primaryKey(),
  // A US state / Canadian province / Caribbean country code (PA, ON, JM); '' when unknown.
  region: text('region').notNull(),
  // The routing table's code (OCSS spec §3.3: US-KY, CA-ON, KY), which region
  // can't be: KY and MS each mean two places. Null: non-geographic, unknown,
  // or a row from before this column until the next refresh.
  stateCode: text('state_code'),
  geographic: integer('geographic', { mode: 'boolean' }).notNull(),
  inService: integer('in_service', { mode: 'boolean' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Real, assigned NPA-NXX exchanges with their rate centers (spec §4.4). A
 * code that leaves NANPA's file is withdrawn, not deleted: numbers already
 * issued in it keep working; it is no longer offered for new ones.
 */
export const exchanges = sqliteTable(
  'exchanges',
  {
    npaNxx: text('npa_nxx').primaryKey(), // 6 digits
    npa: text('npa').notNull(),
    nxx: text('nxx').notNull(),
    region: text('region').notNull(),
    rateCenter: text('rate_center').notNull(), // the key into rate_centers.name
    ocn: text('ocn'),
    company: text('company'),
    firstSeenAt: integer('first_seen_at').notNull(),
    withdrawnAt: integer('withdrawn_at'),
  },
  // exchanges_rc: place search's prefix match on the rate center, on every key press.
  (t) => [index('exchanges_place').on(t.region, t.rateCenter), index('exchanges_npa').on(t.npa), index('exchanges_rc').on(t.rateCenter)],
);

/** Rate centers: a pretty name and, where Local Calling Guide has them, coordinates (place search only, spec §4.4). */
export const rateCenters = sqliteTable(
  'rate_centers',
  {
    region: text('region').notNull(),
    // NANPA's 10-character code (US) or the upper-cased exchange area (Canada): exchanges.rateCenter.
    name: text('name').notNull(),
    display: text('display').notNull(),
    lat: real('lat'),
    lon: real('lon'),
  },
  (t) => [primaryKey({ columns: [t.region, t.name] })],
);

/** One row per weekly NANPA refresh (spec §4.4: "the changes are logged on the admin page"). */
export const nanpaRefreshes = sqliteTable('nanpa_refreshes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  detail: text('detail').notNull(), // JSON: RefreshResult (+ errors)
});
