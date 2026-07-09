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
  {
    id: 2,
    // bearer_token is plaintext until the encrypted vault lands in Part 3.
    sql: `
      CREATE TABLE upstreams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        bearer_token TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
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
    `,
  },
  {
    id: 3,
    // *_enc columns hold Vault ciphertext (v1:...). Pre-existing plaintext
    // bearer tokens are encrypted in place at app startup once a vault exists.
    sql: `
      ALTER TABLE upstreams ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE upstreams ADD COLUMN oauth_client_info_enc TEXT;
      UPDATE upstreams SET auth_mode = 'bearer' WHERE bearer_token IS NOT NULL;
      CREATE TABLE linked_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        tokens_enc TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (upstream_id, label)
      );
    `,
  },
  {
    id: 4,
    // Which linked account a client connection (API key) uses per upstream.
    sql: `
      CREATE TABLE bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (api_key_id, upstream_id)
      );
    `,
  },
  {
    id: 5,
    // OAuth 2.1 authorization server toward clients. Each approved grant gets
    // its own row in api_keys (name 'oauth:...') so bindings/audit reuse the
    // same connection identity as header API keys; its key_hash is random and
    // unusable as a bearer key. Token/code values are stored hashed.
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
    `,
  },
  {
    id: 6,
    // Profiles are allowlists; a connection without one sees the full catalog.
    // audit_log stores metadata only — detail holds control-plane-generated
    // strings, never upstream payloads.
    sql: `
      CREATE TABLE profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE profile_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        upstream_name TEXT NOT NULL,
        tool_pattern TEXT NOT NULL DEFAULT '*',
        UNIQUE (profile_id, upstream_name, tool_pattern)
      );
      ALTER TABLE api_keys ADD COLUMN profile_id INTEGER REFERENCES profiles(id);
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        api_key_id INTEGER NOT NULL,
        key_name TEXT NOT NULL,
        tool TEXT NOT NULL,
        upstream TEXT,
        account TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'denied', 'account_required')),
        duration_ms INTEGER NOT NULL,
        detail TEXT
      );
      CREATE INDEX idx_audit_ts ON audit_log(ts);
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
