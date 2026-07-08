import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createApiKey, revokeApiKey } from "../src/keys.js";

interface TestServer {
  app: App;
  server: Server;
  url: string;
}

let running: TestServer | undefined;
const clients: Client[] = [];

async function startServer(): Promise<TestServer> {
  const app = await buildApp(loadConfig({ dbPath: ":memory:", port: 0 }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  running = { app, server, url: `http://127.0.0.1:${port}` };
  return running;
}

async function connectClient(url: string, key: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  clients.length = 0;
  if (running) {
    await running.app.close();
    await new Promise((resolve) => running!.server.close(resolve));
    running = undefined;
  }
});

describe("gateway auth", () => {
  it("rejects requests without an API key", async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects an invalid API key", async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer cpk_not-a-real-key",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a revoked key", async () => {
    const { url, app } = await startServer();
    const { key } = createApiKey(app.db, "doomed");
    revokeApiKey(app.db, "doomed");
    await expect(connectClient(url, key)).rejects.toThrow();
  });
});

describe("gateway sessions and tools", () => {
  it("initializes, lists tools, and calls control_plane_status", async () => {
    const { url, app } = await startServer();
    const { key } = createApiKey(app.db, "cursor");
    const client = await connectClient(url, key);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("control_plane_status");

    const result = await client.callTool({ name: "control_plane_status", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0].text;
    const status = JSON.parse(text);
    expect(status.status).toBe("ok");
    expect(status.connection.keyName).toBe("cursor");
    expect(status.sessionId).toBeTruthy();
    expect(app.gateway.sessions.size).toBe(1);
  });

  it("supports concurrent sessions from different keys", async () => {
    const { url, app } = await startServer();
    const { key: keyA } = createApiKey(app.db, "client-a");
    const { key: keyB } = createApiKey(app.db, "client-b");
    const [clientA, clientB] = await Promise.all([connectClient(url, keyA), connectClient(url, keyB)]);

    const [resultA, resultB] = await Promise.all([
      clientA.callTool({ name: "control_plane_status", arguments: {} }),
      clientB.callTool({ name: "control_plane_status", arguments: {} }),
    ]);
    const nameOf = (r: unknown) =>
      JSON.parse(((r as { content: { text: string }[] }).content)[0].text).connection.keyName;
    expect(nameOf(resultA)).toBe("client-a");
    expect(nameOf(resultB)).toBe("client-b");
    expect(app.gateway.sessions.size).toBe(2);
  });

  it("denies reuse of a session by a different key", async () => {
    const { url, app } = await startServer();
    const { key: keyA } = createApiKey(app.db, "owner");
    const { key: keyB } = createApiKey(app.db, "intruder");
    await connectClient(url, keyA);

    const sessionId = [...app.gateway.sessions.keys()][0];
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${keyB}`,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });
    expect(res.status).toBe(403);
  });

  it("terminates a session on DELETE", async () => {
    const { url, app } = await startServer();
    const { key } = createApiKey(app.db, "ephemeral");
    const client = await connectClient(url, key);
    expect(app.gateway.sessions.size).toBe(1);
    const sessionId = [...app.gateway.sessions.keys()][0];

    await fetch(`${url}/mcp`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}`, "mcp-session-id": sessionId },
    });
    expect(app.gateway.sessions.size).toBe(0);
    await client.close();
  });
});

describe("health", () => {
  it("serves /healthz without auth", async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });
});
