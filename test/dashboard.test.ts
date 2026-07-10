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
import { addUpstream, listUpstreams } from "../src/upstream/registry.js";
import { Vault } from "../src/vault/index.js";
import { startMockOAuthUpstream, type MockOAuthUpstream } from "./mockOAuthUpstream.js";

const OWNER_PASSWORD = "dash-owner-pw";
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
  const dbPath = `${process.env.TEMP ?? "/tmp"}/cp-dash-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

  const app = await buildApp(
    loadConfig({
      dbPath,
      port,
      publicUrl: baseUrl,
      masterKey: Vault.generateKey(),
      ownerPassword: OWNER_PASSWORD, // exercises the bootstrap path
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.app.listen(port, "127.0.0.1", () => resolve(s));
  });
  onCleanup(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { app, baseUrl, mock };
}

/** Logs in and returns the session cookie + CSRF token, like a browser would. */
async function dashLogin(baseUrl: string, password = OWNER_PASSWORD): Promise<{ cookie: string; csrf: string }> {
  const login = await fetch(`${baseUrl}/dashboard/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }),
  });
  if (login.status !== 302) throw new Error(`login failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const overview = await fetch(`${baseUrl}/dashboard`, { headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await overview.text())![1];
  return { cookie, csrf };
}

const post = (baseUrl: string, path: string, cookie: string, body: Record<string, string>) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams(body),
  });

describe("dashboard auth", () => {
  it("redirects unauthenticated visitors to login and rejects wrong passwords", async () => {
    const { baseUrl } = await startStack();
    const anon = await fetch(`${baseUrl}/dashboard`, { redirect: "manual" });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/dashboard/login");

    await expect(dashLogin(baseUrl, "wrong")).rejects.toThrow(/401/);

    const noSession = await post(baseUrl, "/dashboard/keys/create", "", { name: "x", csrf: "y" });
    expect(noSession.status).toBe(401);
  });

  it("rejects POSTs with a valid session but wrong CSRF token", async () => {
    const { baseUrl } = await startStack();
    const { cookie } = await dashLogin(baseUrl);
    const res = await post(baseUrl, "/dashboard/keys/create", cookie, { name: "x", csrf: "forged" });
    expect(res.status).toBe(403);
  });
});

describe("dashboard operations", () => {
  it("creates and revokes API keys", async () => {
    const { app, baseUrl } = await startStack();
    const { cookie, csrf } = await dashLogin(baseUrl);

    const created = await post(baseUrl, "/dashboard/keys/create", cookie, { name: "laptop", csrf });
    expect(created.status).toBe(200);
    expect(await created.text()).toMatch(/cpk_[A-Za-z0-9_-]+/);

    const revoked = await post(baseUrl, "/dashboard/keys/revoke", cookie, { name: "laptop", csrf });
    expect(revoked.status).toBe(302);
    const row = app.db.prepare("SELECT revoked_at FROM api_keys WHERE name = 'laptop'").get() as {
      revoked_at: string | null;
    };
    expect(row.revoked_at).not.toBeNull();
  });

  it("adds and removes upstreams", async () => {
    const { app, baseUrl, mock } = await startStack();
    const { cookie, csrf } = await dashLogin(baseUrl);

    await post(baseUrl, "/dashboard/upstreams/add", cookie, {
      name: "second",
      url: mock.url,
      authMode: "oauth",
      bearer: "",
      csrf,
    });
    expect(listUpstreams(app.db).map((u) => u.name)).toContain("second");

    await post(baseUrl, "/dashboard/upstreams/remove", cookie, { name: "second", csrf });
    expect(listUpstreams(app.db).map((u) => u.name)).not.toContain("second");
  });

  it("links an account entirely through the browser (remote-deploy flow)", async () => {
    const { app, baseUrl, mock } = await startStack();
    const { cookie, csrf } = await dashLogin(baseUrl);
    mock.setNextUser("railway-user");

    const begin = await post(baseUrl, "/dashboard/accounts/link", cookie, {
      upstream: "vendor",
      label: "me@example.com",
      csrf,
    });
    expect(begin.status).toBe(302);
    const authorizeUrl = begin.headers.get("location")!;
    expect(authorizeUrl).toContain(mock.issuer);

    // The browser follows: vendor auto-approves -> redirects to /upstream-callback.
    const done = await fetch(authorizeUrl);
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
