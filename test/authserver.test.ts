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
import { createApiKey } from "../src/keys.js";
import { Vault } from "../src/vault/index.js";
import { googleSignIn, MOCK_GOOGLE_CLIENT_ID, startMockGoogle, type MockGoogle } from "./mockGoogle.js";

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
async function startStack(): Promise<{ app: App; baseUrl: string; google: MockGoogle }> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const google = await startMockGoogle();
  onCleanup(() => google.close());
  const dbPath = `${process.env.TEMP ?? "/tmp"}/cp-as-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  onCleanup(async () => {
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
  });

  const app = await buildApp(
    loadConfig({
      dbPath,
      port,
      publicUrl: baseUrl,
      masterKey: Vault.generateKey(),
      googleClientId: MOCK_GOOGLE_CLIENT_ID,
      googleClientSecret: "test-secret",
      googleEndpoints: google.endpoints,
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.app.listen(port, "127.0.0.1", () => resolve(s));
  });
  onCleanup(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { app, baseUrl, google };
}

/** A signed-in SaaS user (the consent screen requires one). */
async function signInUser(baseUrl: string, google: MockGoogle, email = "owner@example.com"): Promise<string> {
  const { cookie } = await googleSignIn(baseUrl, google, { sub: `g-${email}`, email, name: "Test User" });
  return cookie;
}

/** Walks the consent screen like a browser with the given session; returns the redirect. */
async function approveConsent(baseUrl: string, cookie: string, consentUrl: string, action = "approve"): Promise<string> {
  const pageRes = await fetch(consentUrl, { headers: { cookie } });
  const html = await pageRes.text();
  const flow = /name="flow" value="([^"]+)"/.exec(html)?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!flow || !csrf) throw new Error(`consent page missing flow/csrf: ${pageRes.status} ${html.slice(0, 160)}`);
  const consent = await fetch(`${baseUrl}/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ flow, csrf, action }),
  });
  const location = consent.headers.get("location");
  if (consent.status !== 302 || !location) throw new Error(`consent failed: ${consent.status}`);
  return location;
}

/** In-memory OAuthClientProvider that drives the consent UI as a signed-in user. */
class TestClientProvider implements OAuthClientProvider {
  private clientInfo: OAuthClientInformationMixed | undefined;
  private savedTokens: OAuthTokens | undefined;
  private verifier: string | undefined;
  authorizationCode: string | undefined;

  constructor(
    private baseUrl: string,
    private cookie: string,
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
    // /authorize 302s to /oauth/consent; the session cookie rides along same-origin.
    const location = await approveConsent(this.baseUrl, this.cookie, authorizationUrl.toString());
    const code = new URL(location).searchParams.get("code");
    if (!code) throw new Error(`no code in redirect: ${location}`);
    this.authorizationCode = code;
  }
}

async function oauthConnect(
  baseUrl: string,
  cookie: string,
  existingProvider?: TestClientProvider,
): Promise<{ client: Client; provider: TestClientProvider }> {
  const provider = existingProvider ?? new TestClientProvider(baseUrl, cookie);
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

/** Registers an OAuth client + starts authorization manually; returns the consent URL. */
async function startManualAuthorization(
  baseUrl: string,
  verifier: string,
): Promise<{ consentUrl: string; clientId: string }> {
  const registration = await (
    await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "manual-client",
        redirect_uris: ["http://127.0.0.1:9/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
  ).json();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = await fetch(
    `${baseUrl}/authorize?client_id=${registration.client_id}&response_type=code` +
      `&redirect_uri=${encodeURIComponent("http://127.0.0.1:9/callback")}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`,
    { redirect: "manual" },
  );
  return { consentUrl: `${baseUrl}${authorize.headers.get("location")}`, clientId: registration.client_id };
}

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

  it("runs the full flow and binds the connection to the consenting user", async () => {
    const { app, baseUrl, google } = await startStack();
    const cookie = await signInUser(baseUrl, google);
    const { client } = await oauthConnect(baseUrl, cookie);

    const status = JSON.parse(firstText(await client.callTool({ name: "control_plane_status", arguments: {} })));
    expect(status.status).toBe("ok");
    expect(status.connection.keyName).toBe("oauth:test-web-client");

    const row = app.db
      .prepare(
        "SELECT u.email FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.name = 'oauth:test-web-client'",
      )
      .get() as { email: string };
    expect(row.email).toBe("owner@example.com");
  });

  it("sends unauthenticated consent visitors to Google sign-in and back", async () => {
    const { baseUrl, google } = await startStack();
    const { consentUrl } = await startManualAuthorization(baseUrl, randomBytes(32).toString("base64url"));

    const anon = await fetch(consentUrl, { redirect: "manual" });
    expect(anon.status).toBe(302);
    const signInLocation = anon.headers.get("location")!;
    expect(signInLocation).toMatch(/^\/auth\/google\?next=/);
    expect(decodeURIComponent(signInLocation)).toContain("/oauth/consent?flow=");

    // After signing in, the same consent URL renders and approval works.
    const cookie = await signInUser(baseUrl, google);
    const location = await approveConsent(baseUrl, cookie, consentUrl);
    expect(new URL(location).searchParams.get("code")).toBeTruthy();
  });

  it("redirects with access_denied when the user denies", async () => {
    const { baseUrl, google } = await startStack();
    const cookie = await signInUser(baseUrl, google);
    const { consentUrl } = await startManualAuthorization(baseUrl, randomBytes(32).toString("base64url"));
    const location = new URL(await approveConsent(baseUrl, cookie, consentUrl, "deny"));
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("rejects a token exchange with a wrong PKCE verifier", async () => {
    const { baseUrl, google } = await startStack();
    const cookie = await signInUser(baseUrl, google);
    const verifier = randomBytes(32).toString("base64url");
    const { consentUrl, clientId } = await startManualAuthorization(baseUrl, verifier);
    const location = new URL(await approveConsent(baseUrl, cookie, consentUrl));
    const code = location.searchParams.get("code")!;

    const exchange = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: randomBytes(32).toString("base64url"), // wrong verifier
        redirect_uri: "http://127.0.0.1:9/callback",
      }),
    });
    expect(exchange.status).toBe(400);
    expect((await exchange.json()).error).toBe("invalid_grant");
  });

  it("refreshes an expired access token transparently", async () => {
    const { app, baseUrl, google } = await startStack();
    const cookie = await signInUser(baseUrl, google);
    const { client } = await oauthConnect(baseUrl, cookie);
    await client.callTool({ name: "control_plane_status", arguments: {} });

    app.db.prepare("UPDATE oauth_tokens SET expires_at = 0 WHERE kind = 'access'").run();
    const status = JSON.parse(firstText(await client.callTool({ name: "control_plane_status", arguments: {} })));
    expect(status.status).toBe("ok");
  });

  it("rejects tokens of a revoked connection", async () => {
    const { app, baseUrl, google } = await startStack();
    const cookie = await signInUser(baseUrl, google);
    const { provider } = await oauthConnect(baseUrl, cookie);
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

  it("reuses the connection row when the same client re-authorizes for the same user", async () => {
    const { app, baseUrl, google } = await startStack();
    const cookie = await signInUser(baseUrl, google);
    const { client: firstClient, provider } = await oauthConnect(baseUrl, cookie);
    await firstClient.close();

    const reauthProvider = new TestClientProvider(baseUrl, cookie);
    reauthProvider.saveClientInformation(provider.clientInformation()!);
    const { client: secondClient } = await oauthConnect(baseUrl, cookie, reauthProvider);

    const status = JSON.parse(firstText(await secondClient.callTool({ name: "control_plane_status", arguments: {} })));
    expect(status.connection.keyName).toBe("oauth:test-web-client");
    const oauthRows = app.db
      .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE name LIKE 'oauth:%'")
      .get() as { n: number };
    expect(oauthRows.n).toBe(1);
  });

  it("serves API-key and OAuth connections side by side with distinct identities", async () => {
    const { app, baseUrl, google } = await startStack();
    const cookie = await signInUser(baseUrl, google);
    const { client: oauthClient } = await oauthConnect(baseUrl, cookie);

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
