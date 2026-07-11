import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface Migration {
  id: number;
  sql: string;
}

// Fresh SaaS-native schema (Phase 2 reset). Pre-SaaS databases are refused at
// boot — delete the data directory/volume; there is no upgrade path from the
// single-tenant era. *_enc columns hold Vault ciphertext (v1:...); token/code
// values are stored hashed; audit detail never holds payloads.
const MIGRATIONS: Migration[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_sub TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        avatar_url TEXT,
        slug TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT
      );

      CREATE TABLE user_sessions (
        id_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_profiles_user ON profiles(user_id);

      CREATE TABLE profile_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        upstream_name TEXT NOT NULL,
        tool_pattern TEXT NOT NULL DEFAULT '*',
        UNIQUE (profile_id, upstream_name, tool_pattern)
      );

      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        key_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        profile_id INTEGER REFERENCES profiles(id),
        oauth_client_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        revoked_at TEXT
      );
      CREATE INDEX idx_api_keys_user ON api_keys(user_id);

      CREATE TABLE upstreams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        bearer_token TEXT,
        auth_mode TEXT NOT NULL DEFAULT 'none',
        oauth_client_info_enc TEXT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_upstreams_user ON upstreams(user_id);

      CREATE TABLE upstream_tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        exposed_name TEXT NOT NULL UNIQUE,
        description TEXT,
        input_schema TEXT NOT NULL,
        ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (upstream_id, original_name)
      );

      CREATE TABLE linked_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        tokens_enc TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (upstream_id, label)
      );

      CREATE TABLE bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (api_key_id, upstream_id)
      );

      CREATE TABLE oauth_clients (
        client_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        code_challenge TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
        client_id TEXT NOT NULL,
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        api_key_id INTEGER NOT NULL,
        user_id INTEGER,
        key_name TEXT NOT NULL,
        tool TEXT NOT NULL,
        upstream TEXT,
        account TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'denied', 'account_required')),
        duration_ms INTEGER NOT NULL,
        detail TEXT
      );
      CREATE INDEX idx_audit_ts ON audit_log(ts);
      CREATE INDEX idx_audit_user ON audit_log(user_id);
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
  const applied = db.prepare("SELECT id FROM migrations").all().map((row) => (row as { id: number }).id);
  if (applied.some((id) => id > MIGRATIONS.length)) {
    throw new Error(
      "This database is from the pre-SaaS (Phase 1) schema and cannot be upgraded — delete the data directory/volume and start fresh.",
    );
  }
  const appliedSet = new Set(applied);
  const apply = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO migrations (id) VALUES (?)").run(migration.id);
  });
  for (const migration of MIGRATIONS) {
    if (!appliedSet.has(migration.id)) apply(migration);
  }
}
