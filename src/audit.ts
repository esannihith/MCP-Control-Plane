import type { Db } from "./db/index.js";

export type AuditOutcome = "ok" | "error" | "denied" | "account_required";

export interface AuditEntry {
  apiKeyId: number;
  keyName: string;
  tool: string;
  upstream?: string | null;
  account?: string | null;
  outcome: AuditOutcome;
  durationMs: number;
  /** Control-plane-generated summary only — never upstream payloads. */
  detail?: string | null;
}

export interface AuditRow extends AuditEntry {
  id: number;
  ts: string;
}

export function recordAudit(db: Db, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log (api_key_id, key_name, tool, upstream, account, outcome, duration_ms, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.apiKeyId,
    entry.keyName,
    entry.tool,
    entry.upstream ?? null,
    entry.account ?? null,
    entry.outcome,
    Math.max(0, Math.round(entry.durationMs)),
    entry.detail?.slice(0, 200) ?? null,
  );
}

export function listAudit(db: Db, options: { limit?: number; apiKeyId?: number } = {}): AuditRow[] {
  const limit = options.limit ?? 50;
  const rows = (
    options.apiKeyId == null
      ? db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit)
      : db.prepare("SELECT * FROM audit_log WHERE api_key_id = ? ORDER BY id DESC LIMIT ?").all(options.apiKeyId, limit)
  ) as {
    id: number;
    ts: string;
    api_key_id: number;
    key_name: string;
    tool: string;
    upstream: string | null;
    account: string | null;
    outcome: AuditOutcome;
    duration_ms: number;
    detail: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    apiKeyId: row.api_key_id,
    keyName: row.key_name,
    tool: row.tool,
    upstream: row.upstream,
    account: row.account,
    outcome: row.outcome,
    durationMs: row.duration_ms,
    detail: row.detail,
  }));
}
