import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();

// A SaaS instance must not boot half-configured: without these, sign-in or
// token encryption would silently be broken.
const missing: string[] = [];
if (!config.masterKey) missing.push("CP_MASTER_KEY (generate: npm run key -- master)");
if (!config.googleClientId) missing.push("GOOGLE_CLIENT_ID");
if (!config.googleClientSecret) missing.push("GOOGLE_CLIENT_SECRET");
if (missing.length > 0) {
  if (process.env.NODE_ENV === "production") {
    console.error(`Refusing to start — missing required environment variables:\n  - ${missing.join("\n  - ")}`);
    process.exit(1);
  }
  console.warn(`WARNING: missing env vars (dev mode continues, features degraded):\n  - ${missing.join("\n  - ")}`);
}

const { app, manager, close } = await buildApp(config);

const server = app.listen(config.port, config.host, () => {
  console.log(`mcp-control-plane listening on http://${config.host}:${config.port}`);
  console.log(`App: ${config.publicUrl}/app  |  MCP endpoint: ${config.publicUrl}/mcp`);
  for (const upstream of manager.status()) {
    console.log(
      `upstream '${upstream.name}' (${upstream.url}): ${upstream.connected ? "connected" : "DISCONNECTED"}, ${upstream.toolCount} tools`,
    );
  }
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  server.close();
  await close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
