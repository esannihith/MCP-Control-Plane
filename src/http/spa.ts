import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import express, { Router } from "express";

/**
 * Serves the built frontend (web/dist) under /app with an SPA fallback.
 * In dev, run `npm run web:dev` instead (Vite proxies /api and /auth here).
 */
export function createSpa(): Router {
  const router = Router();
  const dist = resolve(process.cwd(), "web/dist");
  const index = join(dist, "index.html");

  if (!existsSync(index)) {
    router.get(["/app", "/app/*splat"], (_req, res) => {
      res
        .status(503)
        .type("text/plain")
        .send("Frontend not built. Run: npm run web:build (or use the Vite dev server: npm run web:dev).");
    });
    return router;
  }

  router.use("/app", express.static(dist, { index: false, maxAge: "1h" }));
  router.get(["/app", "/app/*splat"], (_req, res) => {
    res.set("Cache-Control", "no-store").sendFile(index);
  });
  return router;
}
