import type { Db } from "../db/index.js";

export interface Binding {
  upstreamId: number;
  accountId: number;
}

export function getBinding(db: Db, apiKeyId: number, upstreamId: number): number | null {
  const row = db
    .prepare("SELECT account_id FROM bindings WHERE api_key_id = ? AND upstream_id = ?")
    .get(apiKeyId, upstreamId) as { account_id: number } | undefined;
  return row?.account_id ?? null;
}

export function setBinding(db: Db, apiKeyId: number, upstreamId: number, accountId: number): void {
  db.prepare(
    `INSERT INTO bindings (api_key_id, upstream_id, account_id) VALUES (?, ?, ?)
     ON CONFLICT (api_key_id, upstream_id)
     DO UPDATE SET account_id = excluded.account_id, updated_at = datetime('now')`,
  ).run(apiKeyId, upstreamId, accountId);
}

export function listBindings(db: Db, apiKeyId: number): Binding[] {
  return (
    db.prepare("SELECT upstream_id, account_id FROM bindings WHERE api_key_id = ? ORDER BY upstream_id").all(apiKeyId) as {
      upstream_id: number;
      account_id: number;
    }[]
  ).map((row) => ({ upstreamId: row.upstream_id, accountId: row.account_id }));
}
