import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Where the SQL migrations live: the repository's `drizzle/`, next to package.json. */
export const MIGRATIONS = join(process.cwd(), 'drizzle');

/** Open (creating if needed) the portal database and bring its schema up to date. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path);
  client.pragma('journal_mode = WAL');
  client.pragma('synchronous = FULL');
  client.pragma('foreign_keys = ON');
  client.pragma('busy_timeout = 5000');
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
