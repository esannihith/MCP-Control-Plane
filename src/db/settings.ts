import type { Db } from "./index.js";

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

const REGISTRY_VERSION_KEY = "registry_version";

/**
 * Monotonic counter bumped by every catalog mutation (upstream added/removed,
 * tools ingested). The server process watches it to broadcast
 * tools/list_changed — including for mutations made by CLI processes, which
 * share the SQLite file but not the process.
 */
export function bumpRegistryVersion(db: Db): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, '1')
     ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  ).run(REGISTRY_VERSION_KEY);
}

export function getRegistryVersion(db: Db): number {
  return Number(getSetting(db, REGISTRY_VERSION_KEY) ?? 0);
}
