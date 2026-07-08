import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Db } from "../db/index.js";
import type { Vault } from "../vault/index.js";

export interface LinkedAccount {
  id: number;
  upstreamId: number;
  label: string;
  linked: boolean;
  createdAt: string;
}

interface AccountRow {
  id: number;
  upstream_id: number;
  label: string;
  tokens_enc: string | null;
  created_at: string;
}

function toAccount(row: AccountRow): LinkedAccount {
  return {
    id: row.id,
    upstreamId: row.upstream_id,
    label: row.label,
    linked: row.tokens_enc != null,
    createdAt: row.created_at,
  };
}

export function listAccounts(db: Db, upstreamId?: number): LinkedAccount[] {
  const rows = (
    upstreamId == null
      ? db.prepare("SELECT * FROM linked_accounts ORDER BY id").all()
      : db.prepare("SELECT * FROM linked_accounts WHERE upstream_id = ? ORDER BY id").all(upstreamId)
  ) as AccountRow[];
  return rows.map(toAccount);
}

/** The account the proxy uses until per-connection bindings arrive in Part 4: oldest linked one. */
export function getDefaultAccount(db: Db, upstreamId: number): LinkedAccount | null {
  const row = db
    .prepare("SELECT * FROM linked_accounts WHERE upstream_id = ? AND tokens_enc IS NOT NULL ORDER BY id LIMIT 1")
    .get(upstreamId) as AccountRow | undefined;
  return row ? toAccount(row) : null;
}

export function upsertAccount(db: Db, upstreamId: number, label: string): LinkedAccount {
  db.prepare("INSERT OR IGNORE INTO linked_accounts (upstream_id, label) VALUES (?, ?)").run(upstreamId, label);
  const row = db
    .prepare("SELECT * FROM linked_accounts WHERE upstream_id = ? AND label = ?")
    .get(upstreamId, label) as AccountRow;
  return toAccount(row);
}

export function deleteAccount(db: Db, upstreamId: number, label: string): boolean {
  return db.prepare("DELETE FROM linked_accounts WHERE upstream_id = ? AND label = ?").run(upstreamId, label).changes > 0;
}

export function saveAccountTokens(db: Db, vault: Vault, accountId: number, tokens: OAuthTokens): void {
  db.prepare("UPDATE linked_accounts SET tokens_enc = ? WHERE id = ?").run(
    vault.encrypt(JSON.stringify(tokens)),
    accountId,
  );
}

export function getAccountTokens(db: Db, vault: Vault, accountId: number): OAuthTokens | undefined {
  const row = db.prepare("SELECT tokens_enc FROM linked_accounts WHERE id = ?").get(accountId) as
    | { tokens_enc: string | null }
    | undefined;
  if (!row?.tokens_enc) return undefined;
  return JSON.parse(vault.decrypt(row.tokens_enc)) as OAuthTokens;
}
