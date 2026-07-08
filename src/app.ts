import express from "express";
import type { Config } from "./config.js";
import { openDb, type Db } from "./db/index.js";
import { createGateway, type Gateway } from "./gateway/router.js";
import { UpstreamManager } from "./upstream/manager.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export interface App {
  app: express.Express;
  db: Db;
  gateway: Gateway;
  manager: UpstreamManager;
  close(): Promise<void>;
}

export async function buildApp(config: Config): Promise<App> {
  const db = openDb(config.dbPath);
  const manager = new UpstreamManager(db);
  await manager.start();
  const gateway = createGateway(db, manager);

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.use(gateway.router);

  return {
    app,
    db,
    gateway,
    manager,
    async close() {
      await gateway.close();
      await manager.stop();
      db.close();
    },
  };
}
