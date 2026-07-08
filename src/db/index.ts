import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface Migration {
  id: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        key_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        revoked_at TEXT
      );
    `,
  },
];

export type Db = Database.Database;

export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    db
      .prepare("SELECT id FROM migrations")
      .all()
      .map((row) => (row as { id: number }).id),
  );
  const apply = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO migrations (id) VALUES (?)").run(migration.id);
  });
  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.id)) apply(migration);
  }
}
