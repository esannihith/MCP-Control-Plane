import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { createApiKey } from "../src/keys.js";
import { listAudit } from "../src/audit.js";
import { addRule, assignProfile, createProfile, getProfileByName } from "../src/profiles.js";
import { addUpstream } from "../src/upstream/registry.js";
import { startMockUpstream } from "./mockUpstream.js";

const cleanups: (() => Promise<unknown>)[] = [];
const onCleanup = (fn: () => Promise<unknown>) => cleanups.push(fn);

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function startStack(): Promise<{ app: App; url: string; connect: (name: string) => Promise<Client> }> {
  const dbPath = `${process.env.TEMP ?? "/tmp"}/cp-prof-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  onCleanup(async () => {
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
  });

  const alpha = await startMockUpstream("alpha");
  const beta = await startMockUpstream("beta");
  onCleanup(() => alpha.close());
  onCleanup(() => beta.close());
  {
    const seed = openDb(dbPath);
    addUpstream(seed, "alpha", alpha.url);
    addUpstream(seed, "beta", beta.url);
    seed.close();
  }

  const app = await buildApp(loadConfig({ dbPath, port: 0 }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  onCleanup(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const connect = async (name: string): Promise<Client> => {
    const { key } = createApiKey(app.db, name);
    const client = new Client({ name, version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    onCleanup(() => client.close());
    return client;
  };
  return { app, url, connect };
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);
const BUILTINS = ["control_plane_status", "list_accounts", "switch_account"];

describe("profiles", () => {
  it("filters tools/list per connection; no profile means full catalog", async () => {
    const { app, connect } = await startStack();
    const profileId = createProfile(app.db, "alpha-only");
    addRule(app.db, profileId, "alpha");

    const restricted = await connect("phone");
    assignProfile(app.db, "phone", profileId);
    const unrestricted = await connect("laptop");

    const restrictedTools = await toolNames(restricted);
    expect(restrictedTools).toEqual(expect.arrayContaining([...BUILTINS, "alpha_echo", "alpha_boom"]));
    expect(restrictedTools).not.toContain("beta_echo");

    const allTools = await toolNames(unrestricted);
    expect(allTools).toEqual(expect.arrayContaining(["alpha_echo", "beta_echo"]));
  });

  it("supports tool-level rules with prefix patterns", async () => {
    const { app, connect } = await startStack();
    const profileId = createProfile(app.db, "echo-only");
    addRule(app.db, profileId, "alpha", "alpha_echo");
    const client = await connect("narrow");
    assignProfile(app.db, "narrow", profileId);

    const tools = await toolNames(client);
    expect(tools).toContain("alpha_echo");
    expect(tools).not.toContain("alpha_boom");
    expect(tools).not.toContain("beta_echo");
  });

  it("blocks calls to filtered tools as unknown, and audits them as denied", async () => {
    const { app, connect } = await startStack();
    const profileId = createProfile(app.db, "alpha-only");
    addRule(app.db, profileId, "alpha");
    const client = await connect("phone");
    assignProfile(app.db, "phone", profileId);

    await expect(client.callTool({ name: "beta_echo", arguments: { message: "x" } })).rejects.toThrow(/Unknown tool/);
    const denied = listAudit(app.db).find((row) => row.tool === "beta_echo");
    expect(denied).toMatchObject({ keyName: "phone", outcome: "denied", upstream: "beta" });
    expect(denied?.detail).toContain("alpha-only");
  });

  it("reports the profile in control_plane_status", async () => {
    const { app, connect } = await startStack();
    const profileId = createProfile(app.db, "alpha-only");
    addRule(app.db, profileId, "alpha");
    const client = await connect("phone");
    assignProfile(app.db, "phone", profileId);

    const status = JSON.parse(
      ((await client.callTool({ name: "control_plane_status", arguments: {} })) as { content: { text: string }[] })
        .content[0].text,
    );
    expect(status.connection.profile).toBe("alpha-only");
    expect(getProfileByName(app.db, "alpha-only")?.rules).toHaveLength(1);
  });
});

describe("audit log", () => {
  it("records one metadata-only row per call: ok, error, and builtin", async () => {
    const { app, connect } = await startStack();
    const client = await connect("auditee");

    await client.callTool({ name: "alpha_echo", arguments: { message: "secret payload text" } });
    await client.callTool({ name: "alpha_boom", arguments: {} });
    await client.callTool({ name: "control_plane_status", arguments: {} });

    const rows = listAudit(app.db);
    const echo = rows.find((r) => r.tool === "alpha_echo")!;
    expect(echo).toMatchObject({ keyName: "auditee", upstream: "alpha", account: null, outcome: "ok" });
    expect(echo.durationMs).toBeGreaterThanOrEqual(0);
    expect(echo.detail).toBeNull();

    // Upstream tool failure -> 'error', but no payload detail leaks into the log.
    const boom = rows.find((r) => r.tool === "alpha_boom")!;
    expect(boom).toMatchObject({ outcome: "error", upstream: "alpha", detail: null });

    expect(rows.find((r) => r.tool === "control_plane_status")).toMatchObject({ outcome: "ok", upstream: null });
    expect(JSON.stringify(rows)).not.toContain("secret payload text");
  });
});
