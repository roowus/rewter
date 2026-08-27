import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

/**
 * `$client` is the raw better-sqlite3 handle drizzle wraps. Drizzle attaches it
 * at runtime but only types it on `drizzle()`'s return, so naming it here is
 * what lets the daemon close the file on shutdown.
 */
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Open (or create) the database, apply PRAGMAs and pending migrations.
 * Pass ":memory:" for tests.
 */
export function openDb(path: string, opts?: { migrationsFolder?: string }): Db {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: opts?.migrationsFolder ?? MIGRATIONS_DIR });
  return db;
}
