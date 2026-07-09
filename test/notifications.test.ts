import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { createApiKey } from "../src/keys.js";
import { addUpstream } from "../src/upstream/registry.js";
import { startMockUpstream } from "./mockUpstream.js";

const cleanups: (() => Promise<unknown>)[] = [];
const onCleanup = (fn: () => Promise<unknown>) => cleanups.push(fn);

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function startStack(): Promise<{ app: App; client: Client; dbPath: string }> {
  const dbPath = `${process.env.TEMP ?? "/tmp"}/cp-notify-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  onCleanup(async () => {
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
  });
  const app = await buildApp(loadConfig({ dbPath, port: 0, registryPollMs: 50 }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  onCleanup(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as AddressInfo;

  const { key } = createApiKey(app.db, "watcher");
  const client = new Client({ name: "watcher", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  onCleanup(() => client.close());
  return { app, client, dbPath };
}

describe("catalog change notifications", () => {
  it("declares the listChanged capability and serves instructions", async () => {
    const { client } = await startStack();
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    const instructions = client.getInstructions();
    expect(instructions).toContain("control plane");
    expect(instructions).toContain("switch_account");
  });

  it("broadcasts tools/list_changed when another process changes the catalog", async () => {
    const { client, dbPath } = await startStack();

    const notified = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => resolve());
    });

    // Simulate the CLI: a separate db handle to the same file registers a new upstream.
    const mock = await startMockUpstream("latevendor");
    onCleanup(() => mock.close());
    const cliDb = openDb(dbPath);
    addUpstream(cliDb, "latevendor", mock.url);
    cliDb.close();

    await Promise.race([
      notified,
      new Promise((_, reject) => setTimeout(() => reject(new Error("no tools/list_changed within 5s")), 5000)),
    ]);

    // The next tools/list (what a reacting client does) is served fresh from the registry.
    // Tool ingestion for 'latevendor' happens on first connect; the upstream row alone
    // already changes control_plane_status output.
    const status = JSON.parse(
      ((await client.callTool({ name: "control_plane_status", arguments: {} })) as { content: { text: string }[] })
        .content[0].text,
    );
    expect(status.upstreams.map((u: { name: string }) => u.name)).toContain("latevendor");
  });
});
