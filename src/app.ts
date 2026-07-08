import express from "express";
import { createAuthServer } from "./authserver/router.js";
import type { Config } from "./config.js";
import { openDb, type Db } from "./db/index.js";
import { createGateway, type Gateway } from "./gateway/router.js";
import { UpstreamManager } from "./upstream/manager.js";
import { Vault } from "./vault/index.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/** Browser-based clients (e.g. MCP Inspector) need CORS on the auth + MCP endpoints. */
function cors(req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version");
  res.set("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}

export interface App {
  app: express.Express;
  db: Db;
  gateway: Gateway;
  manager: UpstreamManager;
  vault: Vault | null;
  close(): Promise<void>;
}

/** Encrypts any plaintext bearer tokens left from before the vault existed. */
function encryptPlaintextBearerTokens(db: Db, vault: Vault): void {
  const rows = db
    .prepare("SELECT id, bearer_token FROM upstreams WHERE bearer_token IS NOT NULL")
    .all() as { id: number; bearer_token: string }[];
  const update = db.prepare("UPDATE upstreams SET bearer_token = ? WHERE id = ?");
  for (const row of rows) {
    if (!Vault.isEncrypted(row.bearer_token)) update.run(vault.encrypt(row.bearer_token), row.id);
  }
}

export async function buildApp(config: Config): Promise<App> {
  const db = openDb(config.dbPath);
  const vault = config.masterKey ? new Vault(config.masterKey) : null;
  if (vault) encryptPlaintextBearerTokens(db, vault);
  const manager = new UpstreamManager(db, vault);
  await manager.start();
  const authServer = createAuthServer(db, config);
  const gateway = createGateway(db, manager, {
    tokenVerifier: authServer.provider,
    resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`,
  });

  const app = express();
  app.use(cors);
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.use(authServer.router);
  app.use(gateway.router);

  return {
    app,
    db,
    gateway,
    manager,
    vault,
    async close() {
      await gateway.close();
      await manager.stop();
      db.close();
    },
  };
}
