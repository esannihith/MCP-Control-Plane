import "dotenv/config";

export interface Config {
  /** Port the HTTP server listens on. */
  port: number;
  /** Host/interface to bind. Localhost by default; a reverse proxy fronts this in deploys. */
  host: string;
  /** Path to the SQLite database file, or ":memory:" for tests. */
  dbPath: string;
  /** Externally reachable base URL (used later for OAuth metadata and callbacks). */
  publicUrl: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = overrides.port ?? Number(process.env.PORT ?? 8720);
  return {
    port,
    host: overrides.host ?? process.env.CP_HOST ?? "127.0.0.1",
    dbPath: overrides.dbPath ?? process.env.CP_DB_PATH ?? "./data/control-plane.db",
    publicUrl: overrides.publicUrl ?? process.env.CP_PUBLIC_URL ?? `http://localhost:${port}`,
  };
}
