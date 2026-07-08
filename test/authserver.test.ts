import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { setOwnerPassword } from "../src/authserver/owner.js";
import { createApiKey } from "../src/keys.js";
import { Vault } from "../src/vault/index.js";

const OWNER_PASSWORD = "correct horse battery staple";
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

/** The auth server's issuer must equal the reachable URL, so pick the port before building. */
async function startStack(): Promise<{ app: App; baseUrl: string }> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = `${process.env.TEMP ?? "/tmp"}/cp-as-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  onCleanup(async () => {
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
  });

  const app = await buildApp(loadConfig({ dbPath, port, publicUrl: baseUrl, masterKey: Vault.generateKey() }));
  setOwnerPassword(app.db, OWNER_PASSWORD);
  const server = await new Promise<Server>((resolve) => {
    const s = app.app.listen(port, "127.0.0.1", () => resolve(s));
  });
  onCleanup(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { app, baseUrl };
}

/** In-memory OAuthClientProvider that drives the consent UI like a human would. */
class TestClientProvider implements OAuthClientProvider {
  private clientInfo: OAuthClientInformationMixed | undefined;
  private savedTokens: OAuthTokens | undefined;
  private verifier: string | undefined;
  authorizationCode: string | undefined;

  constructor(
    private baseUrl: string,
    private password: string,
  ) {}

  get redirectUrl(): string {
    return "http://127.0.0.1:9/callback"; // never fetched: we capture the code from the redirect Location
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "test-web-client",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.clientInfo;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.clientInfo = info;
  }
  tokens() {
    return this.savedTokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.savedTokens = tokens;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error("no verifier");
    return this.verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const consentHtml = await (await fetch(authorizationUrl)).text(); // follows 302 to /oauth/consent
    const flow = /name="flow" value="([^"]+)"/.exec(consentHtml)?.[1];
    if (!flow) throw new Error(`no consent flow in page: ${consentHtml.slice(0, 200)}`);
    const consent = await fetch(`${this.baseUrl}/oauth/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ flow, password: this.password, action: "approve" }),
    });
    const location = consent.headers.get("location");
    if (consent.status !== 302 || !location) throw new Error(`consent failed: ${consent.status}`);
    const code = new URL(location).searchParams.get("code");
    if (!code) throw new Error(`no code in redirect: ${location}`);
    this.authorizationCode = code;
  }
}

async function oauthConnect(baseUrl: string, password = OWNER_PASSWORD): Promise<{ client: Client; provider: TestClientProvider }> {
  const provider = new TestClientProvider(baseUrl, password);
  const client = new Client({ name: "test-web-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: provider });
  try {
    await client.connect(transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    await transport.finishAuth(provider.authorizationCode!);
    await transport.close().catch(() => {});
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: provider }));
  }
  onCleanup(() => client.close());
  return { client, provider };
}

const firstText = (result: unknown): string => (result as { content: { text: string }[] }).content[0].text;

describe("authorization server", () => {
  it("serves discovery metadata", async () => {
    const { baseUrl } = await startStack();
    const as = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(as.issuer.replace(/\/$/, "")).toBe(baseUrl);
    expect(as.registration_endpoint).toBe(`${baseUrl}/register`);
    expect(as.code_challenge_methods_supported).toContain("S256");

    const prm = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.authorization_servers.map((u: string) => u.replace(/\/$/, ""))).toEqual([baseUrl]);
  });

  it("runs the full DCR + PKCE + consent flow and serves MCP with the issued token", async () => {
    const { baseUrl } = await startStack();
    const { client } = await oauthConnect(baseUrl);

    const status = JSON.parse(firstText(await client.callTool({ name: "control_plane_status", arguments: {} })));
    expect(status.status).toBe("ok");
    expect(status.connection.keyName).toMatch(/^oauth:test-web-client:/);
  });

  it("rejects a wrong owner password without issuing a code", async () => {
    const { baseUrl } = await startStack();
    await expect(oauthConnect(baseUrl, "wrong password")).rejects.toThrow(/consent failed: 401/);
  });

  it("redirects with access_denied when the owner denies", async () => {
    const { baseUrl } = await startStack();
    // Register + authorize manually to reach the consent page.
    const registration = await (
      await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "denied-client",
          redirect_uris: ["http://127.0.0.1:9/callback"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      })
    ).json();
    const challenge = createHash("sha256").update("some-verifier-value-that-is-long-enough-42").digest("base64url");
    const authorizeUrl =
      `${baseUrl}/authorize?client_id=${registration.client_id}&response_type=code` +
      `&redirect_uri=${encodeURIComponent("http://127.0.0.1:9/callback")}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`;
    const consentHtml = await (await fetch(authorizeUrl)).text();
    const flow = /name="flow" value="([^"]+)"/.exec(consentHtml)![1];

    const consent = await fetch(`${baseUrl}/oauth/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ flow, password: "", action: "deny" }),
    });
    const location = new URL(consent.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("rejects a token exchange with a wrong PKCE verifier", async () => {
    const { baseUrl } = await startStack();
    const registration = await (
      await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "pkce-client",
          redirect_uris: ["http://127.0.0.1:9/callback"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      })
    ).json();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const consentHtml = await (
      await fetch(
        `${baseUrl}/authorize?client_id=${registration.client_id}&response_type=code` +
          `&redirect_uri=${encodeURIComponent("http://127.0.0.1:9/callback")}` +
          `&code_challenge=${challenge}&code_challenge_method=S256`,
      )
    ).text();
    const flow = /name="flow" value="([^"]+)"/.exec(consentHtml)![1];
    const consent = await fetch(`${baseUrl}/oauth/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ flow, password: OWNER_PASSWORD, action: "approve" }),
    });
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;

    const exchange = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        code,
        code_verifier: randomBytes(32).toString("base64url"), // wrong
        redirect_uri: "http://127.0.0.1:9/callback",
      }),
    });
    expect(exchange.status).toBe(400);
    expect((await exchange.json()).error).toBe("invalid_grant");
  });

  it("refreshes an expired access token transparently", async () => {
    const { app, baseUrl } = await startStack();
    const { client } = await oauthConnect(baseUrl);
    await client.callTool({ name: "control_plane_status", arguments: {} });

    app.db.prepare("UPDATE oauth_tokens SET expires_at = 0 WHERE kind = 'access'").run();
    const status = JSON.parse(firstText(await client.callTool({ name: "control_plane_status", arguments: {} })));
    expect(status.status).toBe("ok");
    const live = app.db
      .prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE kind = 'access' AND expires_at > 0 AND revoked_at IS NULL")
      .get() as { n: number };
    expect(live.n).toBeGreaterThan(0);
  });

  it("rejects tokens of a revoked connection", async () => {
    const { app, baseUrl } = await startStack();
    const { provider } = await oauthConnect(baseUrl);
    const accessToken = provider.tokens()!.access_token;

    app.db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE name LIKE 'oauth:%'").run();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("serves API-key and OAuth connections side by side with distinct identities", async () => {
    const { app, baseUrl } = await startStack();
    const { client: oauthClient } = await oauthConnect(baseUrl);

    const { key } = createApiKey(app.db, "header-client");
    const keyClient = new Client({ name: "header-client", version: "0.0.1" });
    await keyClient.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    onCleanup(() => keyClient.close());

    const [viaOauth, viaKey] = await Promise.all([
      oauthClient.callTool({ name: "control_plane_status", arguments: {} }),
      keyClient.callTool({ name: "control_plane_status", arguments: {} }),
    ]);
    expect(JSON.parse(firstText(viaOauth)).connection.keyName).toMatch(/^oauth:/);
    expect(JSON.parse(firstText(viaKey)).connection.keyName).toBe("header-client");
  });
});
