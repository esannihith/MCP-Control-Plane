import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const { app, close } = buildApp(config);

const server = app.listen(config.port, config.host, () => {
  console.log(`mcp-control-plane listening on http://${config.host}:${config.port}`);
  console.log(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  server.close();
  await close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
