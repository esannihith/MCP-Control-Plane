import express from "express";
import type { Config } from "./config.js";
import { openDb, type Db } from "./db/index.js";
import { createGateway, type Gateway } from "./gateway/router.js";
import { SERVER_NAME, SERVER_VERSION } from "./gateway/mcpServer.js";

export interface App {
  app: express.Express;
  db: Db;
  gateway: Gateway;
  close(): Promise<void>;
}

export function buildApp(config: Config): App {
  const db = openDb(config.dbPath);
  const gateway = createGateway(db);

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
    async close() {
      await gateway.close();
      db.close();
    },
  };
}
