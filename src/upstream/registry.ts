import type { Db } from "../db/index.js";
import { exposedToolName } from "./naming.js";

export type AuthMode = "none" | "bearer" | "oauth";

export interface UpstreamRow {
  id: number;
  name: string;
  url: string;
  bearer_token: string | null;
  auth_mode: AuthMode;
  enabled: number;
}

export interface IngestedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface ExposedTool {
  exposedName: string;
  description: string | null;
  inputSchema: string;
}

export interface ResolvedTool {
  upstreamId: number;
  upstreamName: string;
  originalName: string;
}

export function listUpstreams(db: Db, enabledOnly = false): UpstreamRow[] {
  const where = enabledOnly ? "WHERE enabled = 1" : "";
  return db
    .prepare(`SELECT id, name, url, bearer_token, auth_mode, enabled FROM upstreams ${where} ORDER BY id`)
    .all() as UpstreamRow[];
}

export function getUpstream(db: Db, id: number): UpstreamRow | null {
  const row = db
    .prepare("SELECT id, name, url, bearer_token, auth_mode, enabled FROM upstreams WHERE id = ?")
    .get(id) as UpstreamRow | undefined;
  return row ?? null;
}

export function addUpstream(
  db: Db,
  name: string,
  url: string,
  options: { bearerToken?: string; oauth?: boolean } = {},
): UpstreamRow {
  const authMode: AuthMode = options.oauth ? "oauth" : options.bearerToken ? "bearer" : "none";
  const result = db
    .prepare("INSERT INTO upstreams (name, url, bearer_token, auth_mode) VALUES (?, ?, ?, ?)")
    .run(name, url, options.bearerToken ?? null, authMode);
  return {
    id: Number(result.lastInsertRowid),
    name,
    url,
    bearer_token: options.bearerToken ?? null,
    auth_mode: authMode,
    enabled: 1,
  };
}

export function removeUpstream(db: Db, name: string): boolean {
  return db.prepare("DELETE FROM upstreams WHERE name = ?").run(name).changes > 0;
}

/**
 * Replaces the stored tool list for an upstream with a freshly ingested one.
 * Tools are processed in sorted order so exposed-name assignment is deterministic.
 */
export function refreshUpstreamTools(db: Db, upstream: { id: number; name: string }, tools: IngestedTool[]): number {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM upstream_tools WHERE upstream_id = ?").run(upstream.id);
    const taken = new Set(
      (db.prepare("SELECT exposed_name FROM upstream_tools").all() as { exposed_name: string }[]).map(
        (row) => row.exposed_name,
      ),
    );
    const insert = db.prepare(
      "INSERT INTO upstream_tools (upstream_id, original_name, exposed_name, description, input_schema) VALUES (?, ?, ?, ?, ?)",
    );
    for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      const exposed = exposedToolName(upstream.name, tool.name, taken);
      taken.add(exposed);
      insert.run(upstream.id, tool.name, exposed, tool.description ?? null, JSON.stringify(tool.inputSchema));
    }
    return tools.length;
  });
  return replace();
}

export function listExposedTools(db: Db): ExposedTool[] {
  return (
    db
      .prepare(
        `SELECT t.exposed_name, t.description, t.input_schema
         FROM upstream_tools t JOIN upstreams u ON u.id = t.upstream_id
         WHERE u.enabled = 1 ORDER BY t.exposed_name`,
      )
      .all() as { exposed_name: string; description: string | null; input_schema: string }[]
  ).map((row) => ({ exposedName: row.exposed_name, description: row.description, inputSchema: row.input_schema }));
}

export function resolveTool(db: Db, exposedName: string): ResolvedTool | null {
  const row = db
    .prepare(
      `SELECT t.upstream_id, u.name AS upstream_name, t.original_name
       FROM upstream_tools t JOIN upstreams u ON u.id = t.upstream_id
       WHERE t.exposed_name = ? AND u.enabled = 1`,
    )
    .get(exposedName) as { upstream_id: number; upstream_name: string; original_name: string } | undefined;
  return row
    ? { upstreamId: row.upstream_id, upstreamName: row.upstream_name, originalName: row.original_name }
    : null;
}
