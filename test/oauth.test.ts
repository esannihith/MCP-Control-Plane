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
import { listAccounts } from "../src/accounts/index.js";
import { addUpstream, listUpstreams } from "../src/upstream/registry.js";
import { Vault } from "../src/vault/index.js";
import { startMockOAuthUpstream, type MockOAuthUpstream } from "./mockOAuthUpstream.js";

const MASTER_KEY = Vault.generateKey();
const cleanups: (() => Promise<unknown>)[] = [];
const onCleanup = (fn: () => Promise<unknown>) => cleanups.push(fn);

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

function tempDbPath(): string {
  const path = `${process.env.TEMP ?? "/tmp"}/cp-oauth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  onCleanup(async () => {
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
  });
  return path;
}

async function mockUpstream(name: string): Promise<MockOAuthUpstream> {
  const mock = await startMockOAuthUpstream(name);
  onCleanup(() => mock.close());
  return mock;
}

/** Simulates the human: follows the authorization URL; the AS auto-approves and redirects to our loopback callback. */
const approveInBrowser = async (url: URL) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`authorize failed: ${response.status}`);
};

async function linkTestAccount(dbPath: string, mock: MockOAuthUpstream, label: string) {
  const db = openDb(dbPath);
  try {
    const upstream =
      listUpstreams(db).find((u) => u.url === mock.url) ?? addUpstream(db, mock.name, mock.url, { oauth: true });
    return await linkAccount(db, new Vault(MASTER_KEY), upstream, { label, openUrl: approveInBrowser, timeoutMs: 10_000 });
  } finally {
    db.close();
  }
}

async function startStack(dbPath: string): Promise<{ app: App; client: Client }> {
  const app = await buildApp(loadConfig({ dbPath, port: 0, masterKey: MASTER_KEY }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  onCleanup(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as AddressInfo;
  const { key } = createApiKey(app.db, "test-client");
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  onCleanup(() => client.close());
  return { app, client };
}

const firstText = (result: unknown): string =>
  (result as { content: { text: string }[] }).content[0].text;

describe("upstream OAuth", () => {
  it("links an account via DCR + authorization-code + PKCE and proxies calls with vault tokens", async () => {
    const mock = await mockUpstream("gmailish");
    const dbPath = tempDbPath();

    const account = await linkTestAccount(dbPath, mock, "john@example.com");
    expect(account.linked).toBe(true);
    expect(mock.counters.registrations).toBe(1);
    expect(mock.counters.codeGrants).toBe(1);

    const { app, client } = await startStack(dbPath);
    expect(app.manager.status()).toMatchObject([{ name: "gmailish", connected: true }]);

    const result = await client.callTool({ name: "gmailish_echo", arguments: { message: "via oauth" } });
    expect(firstText(result)).toBe("gmailish: via oauth");

    // Tokens and client registration at rest are vault ciphertext, not plaintext.
    const tokensEnc = app.db.prepare("SELECT tokens_enc FROM linked_accounts").get() as { tokens_enc: string };
    const clientEnc = app.db.prepare("SELECT oauth_client_info_enc FROM upstreams").get() as {
      oauth_client_info_enc: string;
    };
    expect(Vault.isEncrypted(tokensEnc.tokens_enc)).toBe(true);
    expect(Vault.isEncrypted(clientEnc.oauth_client_info_enc)).toBe(true);
    expect(tokensEnc.tokens_enc).not.toContain("at_");
  });

  it("refreshes expired access tokens transparently mid-session", async () => {
    const mock = await mockUpstream("gmailish");
    const dbPath = tempDbPath();
    await linkTestAccount(dbPath, mock, "john@example.com");
    const { client } = await startStack(dbPath);

    expect(firstText(await client.callTool({ name: "gmailish_echo", arguments: { message: "one" } }))).toBe(
      "gmailish: one",
    );

    mock.expireAccessTokens();
    const refreshesBefore = mock.counters.refreshGrants;
    const result = await client.callTool({ name: "gmailish_echo", arguments: { message: "two" } });
    expect(firstText(result)).toBe("gmailish: two");
    expect(mock.counters.refreshGrants).toBeGreaterThan(refreshesBefore);
  });

  it("reports a clear failure for an OAuth upstream with no linked account", async () => {
    const mock = await mockUpstream("unlinked");
    const dbPath = tempDbPath();
    {
      const db = openDb(dbPath);
      addUpstream(db, "unlinked", mock.url, { oauth: true });
      db.close();
    }
    const { app } = await startStack(dbPath);
    expect(app.manager.status()).toMatchObject([{ name: "unlinked", connected: false, toolCount: 0 }]);
  });

  it("removes the account row when the link flow fails", async () => {
    const mock = await mockUpstream("flaky");
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    const upstream = addUpstream(db, "flaky", mock.url, { oauth: true });

    await expect(
      linkAccount(db, new Vault(MASTER_KEY), upstream, {
        label: "nope",
        openUrl: async () => {
          throw new Error("user closed the browser");
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow();
    expect(listAccounts(db, upstream.id)).toHaveLength(0);
    db.close();
  });
});
