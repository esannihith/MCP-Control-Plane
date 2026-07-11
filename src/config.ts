import "dotenv/config";

export interface GoogleEndpointsConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  issuer: string | string[];
}

export interface Config {
  /** Port the HTTP server listens on. */
  port: number;
  /** Host/interface to bind. Localhost by default; a reverse proxy fronts this in deploys. */
  host: string;
  /** Path to the SQLite database file, or ":memory:" for tests. */
  dbPath: string;
  /** Externally reachable base URL (used later for OAuth metadata and callbacks). */
  publicUrl: string;
  /** 32-byte vault master key (base64url/base64/hex). Unset → vault features disabled. */
  masterKey?: string;
  /** How often to check for catalog changes (made by CLI processes) to broadcast tools/list_changed. */
  registryPollMs: number;
  /** Google OAuth client for SaaS sign-in. */
  googleClientId?: string;
  googleClientSecret?: string;
  /** Test override: point the Google OIDC flow at a mock. */
  googleEndpoints?: GoogleEndpointsConfig;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = overrides.port ?? Number(process.env.PORT ?? 8720);
  return {
    port,
    host: overrides.host ?? process.env.CP_HOST ?? "127.0.0.1",
    dbPath: overrides.dbPath ?? process.env.CP_DB_PATH ?? "./data/control-plane.db",
    publicUrl: overrides.publicUrl ?? process.env.CP_PUBLIC_URL ?? `http://localhost:${port}`,
    masterKey: overrides.masterKey ?? process.env.CP_MASTER_KEY,
    registryPollMs: overrides.registryPollMs ?? Number(process.env.CP_REGISTRY_POLL_MS ?? 5000),
    googleClientId: overrides.googleClientId ?? process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: overrides.googleClientSecret ?? process.env.GOOGLE_CLIENT_SECRET,
    googleEndpoints: overrides.googleEndpoints,
  };
}
