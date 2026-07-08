import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { createApiKey } from "../src/keys.js";
import { addUpstream } from "../src/upstream/registry.js";
import { startMockUpstream, type MockUpstream } from "./mockUpstream.js";

interface TestStack {
  app: App;
  client: Client;
  url: string;
}

const cleanups: (() => Promise<unknown>)[] = [];

function onCleanup(fn: () => Promise<unknown>): void {
  cleanups.push(fn);
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function mock(name: string, options?: { port?: number; bearerToken?: string }): Promise<MockUpstream> {
  const m = await startMockUpstream(name, options);
  onCleanup(() => m.close());
  return m;
}

/** Registers upstreams in a fresh db file-less app, starts it, and connects an MCP client. */
async function startStack(upstreams: { name: string; url: string; bearer?: string }[]): Promise<TestStack> {
  // Upstream rows must exist before the app boots (manager.start() reads them),
  // and buildApp opens its own db handle — so seed a shared temp file, not ":memory:".
  const tempDb = `${process.env.TEMP ?? "/tmp"}/cp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  onCleanup(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tempDb, { force: true });
    await rm(`${tempDb}-wal`, { force: true });
    await rm(`${tempDb}-shm`, { force: true });
  });
  {
    const seed = openDb(tempDb);
    for (const u of upstreams) addUpstream(seed, u.name, u.url, { bearerToken: u.bearer });
    seed.close();
  }
  const app = await buildApp(loadConfig({ dbPath: tempDb, port: 0 }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  onCleanup(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const { key } = createApiKey(app.db, "test-client");
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  onCleanup(() => client.close());
  return { app, client, url };
}

function firstText(result: unknown): string {
  return (result as { content: { type: string; text: string }[] }).content[0].text;
}

describe("upstream proxying", () => {
  it("exposes namespaced tools from multiple upstreams through one endpoint", async () => {
    const alpha = await mock("alpha");
    const beta = await mock("beta");
    const { client } = await startStack([
      { name: "alpha", url: alpha.url },
      { name: "beta", url: beta.url },
    ]);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("control_plane_status");
    expect(names).toContain("alpha_echo");
    expect(names).toContain("alpha_boom");
    expect(names).toContain("beta_echo");

    const echoTool = tools.tools.find((t) => t.name === "alpha_echo")!;
    expect(echoTool.inputSchema).toMatchObject({ type: "object" });
  });

  it("proxies tool calls to the right upstream", async () => {
    const alpha = await mock("alpha");
    const beta = await mock("beta");
    const { client } = await startStack([
      { name: "alpha", url: alpha.url },
      { name: "beta", url: beta.url },
    ]);

    const fromAlpha = await client.callTool({ name: "alpha_echo", arguments: { message: "hi" } });
    const fromBeta = await client.callTool({ name: "beta_echo", arguments: { message: "yo" } });
    expect(firstText(fromAlpha)).toBe("alpha: hi");
    expect(firstText(fromBeta)).toBe("beta: yo");
  });

  it("passes through upstream tool errors as tool errors", async () => {
    const alpha = await mock("alpha");
    const { client } = await startStack([{ name: "alpha", url: alpha.url }]);
    const result = await client.callTool({ name: "alpha_boom", arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("kaboom");
  });

  it("rejects unknown tools", async () => {
    const alpha = await mock("alpha");
    const { client } = await startStack([{ name: "alpha", url: alpha.url }]);
    await expect(client.callTool({ name: "alpha_nonexistent", arguments: {} })).rejects.toThrow(/Unknown tool/);
  });

  it("degrades to a tool error when an upstream is down, and recovers when it returns", async () => {
    const alpha = await mock("alpha");
    const beta = await startMockUpstream("beta");
    const { client } = await startStack([
      { name: "alpha", url: alpha.url },
      { name: "beta", url: beta.url },
    ]);

    await beta.close();
    const down = await client.callTool({ name: "beta_echo", arguments: { message: "anyone?" } });
    expect(down.isError).toBe(true);
    expect(firstText(down)).toContain("beta");
    expect(firstText(down)).toContain("unavailable");

    // Alpha is unaffected.
    const alive = await client.callTool({ name: "alpha_echo", arguments: { message: "still here" } });
    expect(firstText(alive)).toBe("alpha: still here");

    // Bring beta back on the same port; the next call reconnects lazily.
    const revived = await startMockUpstream("beta", { port: beta.port });
    onCleanup(() => revived.close());
    const back = await client.callTool({ name: "beta_echo", arguments: { message: "welcome back" } });
    expect(back.isError).toBeFalsy();
    expect(firstText(back)).toBe("beta: welcome back");
  });

  it("authenticates to upstreams with a bearer token", async () => {
    const secured = await mock("secured", { bearerToken: "sekrit" });
    const { client, app } = await startStack([
      { name: "secured", url: secured.url, bearer: "sekrit" },
      { name: "locked-out", url: secured.url },
    ]);

    const result = await client.callTool({ name: "secured_echo", arguments: { message: "auth ok" } });
    expect(firstText(result)).toBe("secured: auth ok");

    const status = app.manager.status();
    expect(status.find((s) => s.name === "secured")?.connected).toBe(true);
    expect(status.find((s) => s.name === "locked-out")?.connected).toBe(false);
  });

  it("reports upstream state in control_plane_status", async () => {
    const alpha = await mock("alpha");
    const { client } = await startStack([{ name: "alpha", url: alpha.url }]);
    const status = JSON.parse(firstText(await client.callTool({ name: "control_plane_status", arguments: {} })));
    expect(status.upstreams).toEqual([
      { name: "alpha", url: alpha.url, connected: true, toolCount: 2 },
    ]);
  });
});
