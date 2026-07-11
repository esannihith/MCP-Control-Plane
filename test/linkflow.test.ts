import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { createApiKey } from "../src/keys.js";
import { addUpstream } from "../src/upstream/registry.js";
import { Vault } from "../src/vault/index.js";
import { startMockOAuthUpstream, type MockOAuthUpstream } from "./mockOAuthUpstream.js";

const cleanups: (() => Promise<unknown>)[] = [];
const onCleanup = (fn: () => Promise<unknown>) => cleanups.push(fn);

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function startStack(): Promise<{ app: App; baseUrl: string; mock: MockOAuthUpstream }> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = `${process.env.TEMP ?? "/tmp"}/cp-link-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  onCleanup(async () => {
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
  });

  const mock = await startMockOAuthUpstream("vendor");
  onCleanup(() => mock.close());
  {
    const seed = openDb(dbPath);
    addUpstream(seed, "vendor", mock.url, { oauth: true });
    seed.close();
  }

  const app = await buildApp(loadConfig({ dbPath, port, publicUrl: baseUrl, masterKey: Vault.generateKey() }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.app.listen(port, "127.0.0.1", () => resolve(s));
  });
  onCleanup(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { app, baseUrl, mock };
}

describe("server-side link flow", () => {
  it("completes from a session-free browser via /link/<id> (cross-browser path)", async () => {
    const { app, baseUrl, mock } = await startStack();
    mock.setNextUser("railway-user");

    const started = await app.serverLink!.begin("vendor", "me@example.com");
    // A different browser (no cookies at all) enters via the shareable URL.
    const entry = await fetch(`${baseUrl}/link/${started.flowId}`, { redirect: "manual" });
    expect(entry.status).toBe(302);
    expect(entry.headers.get("location")).toContain(mock.issuer);

    const done = await fetch(entry.headers.get("location")!);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Linked");

    const account = app.db
      .prepare("SELECT tokens_enc FROM linked_accounts WHERE label = 'me@example.com'")
      .get() as { tokens_enc: string | null };
    expect(account.tokens_enc).toMatch(/^v1:/);

    // Tools were ingested and the account is usable end-to-end.
    const { key } = createApiKey(app.db, "probe");
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    onCleanup(() => client.close());
    const result = (await client.callTool({ name: "vendor_whoami", arguments: {} })) as {
      content: { text: string }[];
    };
    expect(result.content[0].text).toBe("user:railway-user");
  });

  it("supersedes an abandoned flow for the same account and retries cleanly", async () => {
    const { app, baseUrl, mock } = await startStack();
    const first = await app.serverLink!.begin("vendor", "retry@example.com");

    mock.setNextUser("second-try");
    const second = await app.serverLink!.begin("vendor", "retry@example.com");
    expect(second.flowId).not.toBe(first.flowId);

    const stale = await fetch(`${baseUrl}/link/${first.flowId}`, { redirect: "manual" });
    expect(stale.status).toBe(410);

    const entry = await fetch(`${baseUrl}/link/${second.flowId}`, { redirect: "manual" });
    const done = await fetch(entry.headers.get("location")!);
    expect(await done.text()).toContain("Linked");
  });

  it("rejects callbacks with unknown state", async () => {
    const { baseUrl } = await startStack();
    const res = await fetch(`${baseUrl}/upstream-callback?code=x&state=unknown`);
    expect(res.status).toBe(400);
  });
});

describe("destructive operations stay off the MCP surface", () => {
  it("exposes no remove/revoke/unlink/delete tools over MCP", async () => {
    const { app, baseUrl } = await startStack();
    const { key } = createApiKey(app.db, "surface-check");
    const client = new Client({ name: "surface-check", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    onCleanup(() => client.close());

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["control_plane_status", "list_accounts", "switch_account"]));
    for (const name of tools) {
      expect(name).not.toMatch(/remove|revoke|unlink|delete|create_key|add_upstream/);
    }
  });
});
