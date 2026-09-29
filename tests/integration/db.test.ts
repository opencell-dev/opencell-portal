import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb } from '@/db';
import { passkeys, sessions, users } from '@/db/schema';

describe('openDb', () => {
  it('creates the schema by migration, with WAL and foreign keys on', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ocp-')), 'sub', 'portal.db');
    const db = openDb(path);
    const tables = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'audit',
        'captcha_used',
        'challenges',
        'email_tokens',
        'passkeys',
        'rate_events',
        'sessions',
        'settings',
        'user_roles',
        'users',
      ]),
    );
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    db.$client.close();
    // A second open runs no migration twice.
    const again = openDb(path);
    expect(again.select().from(users).all()).toEqual([]);
    again.$client.close();
  });

  it('deletes a user’s passkeys and sessions with the user', () => {
    const db = openDb(':memory:');
    const [u] = db
      .insert(users)
      .values({ name: 'A', email: 'a@example.org', createdAt: 1 })
      .returning()
      .all();
    db.insert(passkeys)
      .values({ id: 'cred', userId: u.id, publicKey: Buffer.from([1]), counter: 0, createdAt: 1 })
      .run();
    db.insert(sessions)
      .values({ id: 'h', userId: u.id, method: 'email', createdAt: 1, expiresAt: 2 })
      .run();
    db.delete(users).where(eq(users.id, u.id)).run();
    expect(db.select().from(passkeys).all()).toEqual([]);
    expect(db.select().from(sessions).all()).toEqual([]);
  });

  it('never reuses a deleted user’s id (the audit keeps ids)', () => {
    const db = openDb(':memory:');
    const [a] = db.insert(users).values({ name: 'A', email: 'a@x.org', createdAt: 1 }).returning().all();
    db.delete(users).where(eq(users.id, a.id)).run();
    const [b] = db.insert(users).values({ name: 'B', email: 'b@x.org', createdAt: 1 }).returning().all();
    expect(b.id).toBeGreaterThan(a.id);
  });
});
