import type { Db } from "./db/index.js";

export interface ProfileRule {
  upstreamName: string;
  toolPattern: string;
}

export interface Profile {
  id: number;
  name: string;
  rules: ProfileRule[];
}

export function createProfile(db: Db, name: string): number {
  return Number(db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name).lastInsertRowid);
}

export function deleteProfile(db: Db, name: string): boolean {
  return db.prepare("DELETE FROM profiles WHERE name = ?").run(name).changes > 0;
}

export function listProfiles(db: Db): Profile[] {
  const rows = db.prepare("SELECT id, name FROM profiles ORDER BY id").all() as { id: number; name: string }[];
  return rows.map((row) => ({ ...row, rules: rulesFor(db, row.id) }));
}

function rulesFor(db: Db, profileId: number): ProfileRule[] {
  return (
    db.prepare("SELECT upstream_name, tool_pattern FROM profile_rules WHERE profile_id = ? ORDER BY id").all(profileId) as {
      upstream_name: string;
      tool_pattern: string;
    }[]
  ).map((row) => ({ upstreamName: row.upstream_name, toolPattern: row.tool_pattern }));
}

export function getProfileByName(db: Db, name: string): Profile | null {
  const row = db.prepare("SELECT id, name FROM profiles WHERE name = ?").get(name) as
    | { id: number; name: string }
    | undefined;
  return row ? { ...row, rules: rulesFor(db, row.id) } : null;
}

export function addRule(db: Db, profileId: number, upstreamName: string, toolPattern = "*"): void {
  db.prepare(
    "INSERT OR IGNORE INTO profile_rules (profile_id, upstream_name, tool_pattern) VALUES (?, ?, ?)",
  ).run(profileId, upstreamName, toolPattern);
}

export function removeRule(db: Db, profileId: number, upstreamName: string, toolPattern = "*"): boolean {
  return (
    db
      .prepare("DELETE FROM profile_rules WHERE profile_id = ? AND upstream_name = ? AND tool_pattern = ?")
      .run(profileId, upstreamName, toolPattern).changes > 0
  );
}

export function assignProfile(db: Db, keyName: string, profileId: number | null): boolean {
  return db.prepare("UPDATE api_keys SET profile_id = ? WHERE name = ?").run(profileId, keyName).changes > 0;
}

/** The profile of a connection, or null = unrestricted (full catalog). */
export function getProfileForConnection(db: Db, apiKeyId: number): Profile | null {
  const row = db
    .prepare(
      `SELECT p.id, p.name FROM api_keys k JOIN profiles p ON p.id = k.profile_id WHERE k.id = ?`,
    )
    .get(apiKeyId) as { id: number; name: string } | undefined;
  return row ? { ...row, rules: rulesFor(db, row.id) } : null;
}

/** '*' matches anything; a trailing '*' is a prefix match; otherwise exact. */
function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

export function isToolAllowed(profile: Profile | null, upstreamName: string, exposedName: string): boolean {
  if (!profile) return true;
  return profile.rules.some(
    (rule) => matches(rule.upstreamName, upstreamName) && matches(rule.toolPattern, exposedName),
  );
}
