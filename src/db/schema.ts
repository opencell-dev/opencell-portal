import { sql } from 'drizzle-orm';
import { blob, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
