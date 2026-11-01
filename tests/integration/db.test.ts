import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb } from '@/db';
import { agreementAcceptances, nodeRequests, nodes, numbers, passkeys, sessions, users } from '@/db/schema';

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

describe('migration 0002 (portal P2: numbers)', () => {
  it('creates the P2 tables', () => {
    const db = openDb(':memory:');
    const tables = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['numbers', 'limit_requests', 'npas', 'exchanges', 'rate_centers', 'nanpa_refreshes']));
  });

  it('holds a number once: a second row with the same number is refused (the double-submit guard)', () => {
    const db = openDb(':memory:');
    const [u] = db.insert(users).values({ name: 'A', email: 'a@example.org', createdAt: 1 }).returning().all();
    const row = { number: '+883171746412345', userId: u.id, coreId: 'fake', createdAt: 1, state: 'unactivated' as const };
    db.insert(numbers).values(row).run();
    expect(() => db.insert(numbers).values(row).run()).toThrow(/UNIQUE|PRIMARY/);
    // Listed by default (opt-out, spec §5); gone with the account.
    expect(db.select().from(numbers).get()?.listed).toBe(true);
    db.delete(users).where(eq(users.id, u.id)).run();
    expect(db.select().from(numbers).all()).toEqual([]);
  });
});

describe('migration: the P3 tables', () => {
  const seedUser = (db: ReturnType<typeof openDb>, email = 'op@example.org') => db.insert(users).values({ name: 'Op', email, createdAt: 1 }).returning().get();
  const node = (userId: number, cellId: number) => ({
    requestId: 1,
    userId,
    coreId: 'core1',
    cellId,
    cellName: 'roof',
    certCn: `cell${cellId}-roof`,
    siteName: 'Roof',
    lat: 39.414371,
    lon: -77.410541,
    region: 'MD',
    contactPhone: '+1 301 555 0100',
    anchor: 3,
    cellSeed: 7,
    boardRole: 'bs' as const,
    mode: 'part15' as const,
    listGroup: 0,
    createdAt: 1,
  });
  const request = (userId: number) => ({
    userId,
    siteName: 'Roof',
    lat: 39.414371,
    lon: -77.410541,
    region: 'MD',
    piModel: 'pi5' as const,
    w12Boards: 1,
    gps: true,
    antenna: 'Vertical on the roof',
    backhaul: 'home' as const,
    power: 'mains' as const,
    contactPhone: '+1 301 555 0100',
    agreementVersion: 1,
    agreedAt: 1,
    status: 'pending' as const,
    createdAt: 1,
  });

  it('migration creates the P3 tables', () => {
    const db = openDb(':memory:');
    const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['node_requests', 'node_request_messages', 'agreement_acceptances', 'nodes', 'setup_tokens', 'issued_certs', 'node_state', 'node_downtime']));
    const usersCols = db.$client.prepare('PRAGMA table_info(users)').all().map((r) => (r as { name: string }).name);
    expect(usersCols).toEqual(expect.arrayContaining(['disabled_at', 'disabled_by']));
    const numbersCols = db.$client.prepare('PRAGMA table_info(numbers)').all().map((r) => (r as { name: string }).name);
    expect(numbersCols).toContain('disabled_by');
  });

  it('accepts an agreement version once per account', () => {
    const db = openDb(':memory:');
    const u = seedUser(db);
    db.insert(agreementAcceptances).values({ userId: u.id, version: 1, acceptedAt: 1 }).run();
    expect(() => db.insert(agreementAcceptances).values({ userId: u.id, version: 1, acceptedAt: 2 }).run()).toThrow();
  });

  it('holds one node per core and cell', () => {
    const db = openDb(':memory:');
    const u = seedUser(db);
    db.insert(nodes).values(node(u.id, 5)).run();
    expect(() => db.insert(nodes).values(node(u.id, 5)).run()).toThrow();
    db.insert(nodes).values({ ...node(u.id, 5), coreId: 'core2' }).run();
  });

  it('deleting a user cascades their requests and leaves their nodes without an operator', () => {
    const db = openDb(':memory:');
    const u = seedUser(db);
    db.insert(nodeRequests).values(request(u.id)).run();
    const n = db.insert(nodes).values(node(u.id, 5)).returning().get();
    db.delete(users).where(eq(users.id, u.id)).run();
    expect(db.select().from(nodeRequests).all()).toEqual([]);
    expect(db.select().from(nodes).where(eq(nodes.id, n.id)).get()?.userId).toBeNull();
  });
});
