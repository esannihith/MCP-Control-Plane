import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db/index.js";

export interface ApiKeyInfo {
  id: number;
  name: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface Connection {
  keyId: number;
  keyName: string;
}

const KEY_PREFIX = "cpk_";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Creates an API key and returns the plaintext once; only the hash is stored. */
export function createApiKey(db: Db, name: string): { key: string; id: number } {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  const result = db
    .prepare("INSERT INTO api_keys (name, key_hash) VALUES (?, ?)")
    .run(name, hashKey(key));
  return { key, id: Number(result.lastInsertRowid) };
}

export function verifyApiKey(db: Db, key: string): Connection | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const row = db
    .prepare("SELECT id, name FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .get(hashKey(key)) as { id: number; name: string } | undefined;
  return row ? { keyId: row.id, keyName: row.name } : null;
}

export function listApiKeys(db: Db): ApiKeyInfo[] {
  return (
    db
      .prepare("SELECT id, name, created_at, revoked_at FROM api_keys ORDER BY id")
      .all() as { id: number; name: string; created_at: string; revoked_at: string | null }[]
  ).map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }));
}

export function revokeApiKey(db: Db, name: string): boolean {
  const result = db
    .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE name = ? AND revoked_at IS NULL")
    .run(name);
  return result.changes > 0;
}
