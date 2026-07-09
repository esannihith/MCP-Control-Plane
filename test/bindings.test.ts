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
import { linkAccount } from "../src/accounts/link.js";
import { addUpstream, listUpstreams } from "../src/upstream/registry.js";
import { Vault } from "../src/vault/index.js";
import { startMockOAuthUpstream, type MockOAuthUpstream } from "./mockOAuthUpstream.js";

const MASTER_KEY = Vault.generateKey();
const cleanups: (() => Promise<unknown>)[] = [];
const onCleanup = (fn: () => Promise<unknown>) => cleanups.push(fn);

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

const approveInBrowser = async (url: URL) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`authorize failed: ${response.status}`);
};

function tempDbPath(): string {
  const path = `${process.env.TEMP ?? "/tmp"}/cp-bind-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  onCleanup(async () => {
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
  });
  return path;
}

/** Boots a mock vendor, links the given identities as accounts, and starts the control plane. */
async function startScenario(users: string[]): Promise<{
  app: App;
  mock: MockOAuthUpstream;
  url: string;
  connect: (keyName: string) => Promise<Client>;
}> {
  const mock = await startMockOAuthUpstream("vendor");
  onCleanup(() => mock.close());

  const dbPath = tempDbPath();
  {
    const db = openDb(dbPath);
    const upstream = addUpstream(db, "vendor", mock.url, { oauth: true });
    for (const user of users) {
      mock.setNextUser(user);
      await linkAccount(db, new Vault(MASTER_KEY), upstream, {
        label: `${user}@example.com`,
        openUrl: approveInBrowser,
        timeoutMs: 10_000,
      });
    }
    db.close();
  }

  const app = await buildApp(loadConfig({ dbPath, port: 0, masterKey: MASTER_KEY }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  onCleanup(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const keys = new Map<string, string>();
  const connect = async (keyName: string): Promise<Client> => {
    if (!keys.has(keyName)) keys.set(keyName, createApiKey(app.db, keyName).key);
    const client = new Client({ name: keyName, version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${keys.get(keyName)}` } },
      }),
    );
    onCleanup(() => client.close());
    return client;
  };
  return { app, mock, url, connect };
}

const firstText = (result: unknown): string => (result as { content: { text: string }[] }).content[0].text;
const whoami = async (client: Client) => firstText(await client.callTool({ name: "vendor_whoami", arguments: {} }));

describe("account bindings", () => {
  it("auto-binds when exactly one account is linked", async () => {
    const { app, connect } = await startScenario(["john"]);
    const client = await connect("solo-client");
    expect(await whoami(client)).toBe("user:john");
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bindings").get()).toEqual({ n: 1 });
  });

  it("asks which account to use when several are linked, then honors switch_account", async () => {
    const { connect } = await startScenario(["john", "jane"]);
    const client = await connect("chatgpt");

    const ask = JSON.parse(firstText(await client.callTool({ name: "vendor_whoami", arguments: {} })));
    expect(ask.action_required).toBe("select_account");
    expect(ask.options).toEqual(["john@example.com", "jane@example.com"]);

    const switched = await client.callTool({
      name: "switch_account",
      arguments: { upstream: "vendor", account: "jane@example.com" },
    });
    expect(firstText(switched)).toContain("jane@example.com");
    expect(await whoami(client)).toBe("user:jane");
  });

  it("isolates bindings between client connections, concurrently", async () => {
    const { connect } = await startScenario(["john", "jane"]);
    const chatgpt = await connect("chatgpt");
    const gemini = await connect("gemini");

    await chatgpt.callTool({ name: "switch_account", arguments: { upstream: "vendor", account: "john@example.com" } });
    await gemini.callTool({ name: "switch_account", arguments: { upstream: "vendor", account: "jane@example.com" } });

    const [viaChatgpt, viaGemini] = await Promise.all([whoami(chatgpt), whoami(gemini)]);
    expect(viaChatgpt).toBe("user:john");
    expect(viaGemini).toBe("user:jane");

    // Switching one connection never touches the other.
    await chatgpt.callTool({ name: "switch_account", arguments: { upstream: "vendor", account: "jane@example.com" } });
    expect(await whoami(chatgpt)).toBe("user:jane");
    expect(await whoami(gemini)).toBe("user:jane");
    await gemini.callTool({ name: "switch_account", arguments: { upstream: "vendor", account: "john@example.com" } });
    expect(await whoami(gemini)).toBe("user:john");
    expect(await whoami(chatgpt)).toBe("user:jane");
  });

  it("persists bindings across sessions of the same key", async () => {
    const { connect } = await startScenario(["john", "jane"]);
    const first = await connect("cursor");
    await first.callTool({ name: "switch_account", arguments: { upstream: "vendor", account: "jane@example.com" } });
    await first.close();

    const second = await connect("cursor");
    expect(await whoami(second)).toBe("user:jane");
  });

  it("lists accounts with the caller's active binding", async () => {
    const { connect } = await startScenario(["john", "jane"]);
    const client = await connect("chatgpt");
    await client.callTool({ name: "switch_account", arguments: { upstream: "vendor", account: "john@example.com" } });

    const listed = JSON.parse(firstText(await client.callTool({ name: "list_accounts", arguments: {} })));
    expect(listed).toEqual([
      {
        upstream: "vendor",
        accounts: ["john@example.com", "jane@example.com"],
        active: "john@example.com",
      },
    ]);
  });

  it("rejects switching to an unknown account or upstream helpfully", async () => {
    const { connect } = await startScenario(["john"]);
    const client = await connect("chatgpt");

    const badAccount = await client.callTool({
      name: "switch_account",
      arguments: { upstream: "vendor", account: "nobody@example.com" },
    });
    expect(badAccount.isError).toBe(true);
    expect(firstText(badAccount)).toContain("john@example.com");

    const badUpstream = await client.callTool({
      name: "switch_account",
      arguments: { upstream: "nope", account: "john@example.com" },
    });
    expect(badUpstream.isError).toBe(true);
    expect(firstText(badUpstream)).toContain("Unknown upstream");
  });

  it("reports bindings in control_plane_status", async () => {
    const { connect } = await startScenario(["john"]);
    const client = await connect("chatgpt");
    await whoami(client); // triggers auto-bind
    const status = JSON.parse(firstText(await client.callTool({ name: "control_plane_status", arguments: {} })));
    expect(status.bindings).toEqual([{ upstream: "vendor", account: "john@example.com" }]);
  });

  it("records the bound account label in the audit trail", async () => {
    const { app, connect } = await startScenario(["john"]);
    const client = await connect("chatgpt");
    await whoami(client);
    const { listAudit } = await import("../src/audit.js");
    const row = listAudit(app.db).find((r) => r.tool === "vendor_whoami");
    expect(row).toMatchObject({ upstream: "vendor", account: "john@example.com", outcome: "ok" });
  });
});
