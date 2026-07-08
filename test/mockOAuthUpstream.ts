import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface MockOAuthUpstream {
  name: string;
  url: string;
  issuer: string;
  counters: { registrations: number; authorizations: number; codeGrants: number; refreshGrants: number };
  /** Invalidates all outstanding access tokens, forcing clients onto the refresh path. */
  expireAccessTokens(): void;
  close(): Promise<void>;
}

/**
 * An MCP upstream protected by its own OAuth 2.1 authorization server:
 * RFC 9728 protected-resource metadata, AS metadata, DCR, authorization-code
 * with PKCE (auto-approving "user"), and refresh tokens. The MCP endpoint
 * exposes `whoami` and `echo` tools.
 */
export async function startMockOAuthUpstream(name: string): Promise<MockOAuthUpstream> {
  const counters = { registrations: 0, authorizations: 0, codeGrants: 0, refreshGrants: 0 };
  const clients = new Map<string, { redirect_uris: string[] }>();
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  let issuer = "";

  const metadata = () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });

  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.json({ resource: `${issuer}/mcp`, authorization_servers: [issuer] });
  });
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(metadata()));

  app.post("/register", (req, res) => {
    counters.registrations++;
    const clientId = `client_${randomBytes(8).toString("hex")}`;
    clients.set(clientId, { redirect_uris: req.body.redirect_uris ?? [] });
    res.status(201).json({
      client_id: clientId,
      redirect_uris: req.body.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // Auto-approves: a real AS would show a login/consent page here.
  app.get("/authorize", (req, res) => {
    counters.authorizations++;
    const { client_id, redirect_uri, code_challenge, state, response_type, code_challenge_method } =
      req.query as Record<string, string>;
    const client = clients.get(client_id);
    if (!client || response_type !== "code" || code_challenge_method !== "S256") {
      res.status(400).send("invalid authorization request");
      return;
    }
    if (!client.redirect_uris.includes(redirect_uri)) {
      res.status(400).send("unregistered redirect_uri");
      return;
    }
    const code = `code_${randomBytes(8).toString("hex")}`;
    codes.set(code, { clientId: client_id, challenge: code_challenge, redirectUri: redirect_uri });
    const target = new URL(redirect_uri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    res.redirect(target.toString());
  });

  const issueTokens = () => {
    const accessToken = `at_${randomBytes(12).toString("hex")}`;
    const refreshToken = `rt_${randomBytes(12).toString("hex")}`;
    accessTokens.add(accessToken);
    refreshTokens.add(refreshToken);
    return { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken };
  };

  app.post("/token", (req, res) => {
    const { grant_type, code, code_verifier, refresh_token } = req.body as Record<string, string>;
    if (grant_type === "authorization_code") {
      const pending = codes.get(code);
      const expected = pending?.challenge;
      const actual = createHash("sha256").update(code_verifier ?? "").digest("base64url");
      if (!pending || expected !== actual) {
        res.status(400).json({ error: "invalid_grant", error_description: "bad code or PKCE verifier" });
        return;
      }
      codes.delete(code);
      counters.codeGrants++;
      res.json(issueTokens());
      return;
    }
    if (grant_type === "refresh_token") {
      if (!refreshTokens.has(refresh_token)) {
        res.status(400).json({ error: "invalid_grant", error_description: "unknown refresh token" });
        return;
      }
      counters.refreshGrants++;
      res.json(issueTokens());
      return;
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  app.post("/mcp", async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token || !accessTokens.has(token)) {
      res
        .status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`)
        .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    const server = new McpServer({ name: `mock-oauth-${name}`, version: "0.0.1" });
    server.registerTool("whoami", { description: "Reports the token used" }, async () => ({
      content: [{ type: "text", text: `authorized via ${token.slice(0, 6)}...` }],
    }));
    server.registerTool(
      "echo",
      { description: "Echo back a message", inputSchema: { message: z.string() } },
      async ({ message }) => ({ content: [{ type: "text", text: `${name}: ${message}` }] }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = httpServer.address() as AddressInfo;
  issuer = `http://127.0.0.1:${port}`;

  return {
    name,
    url: `${issuer}/mcp`,
    issuer,
    counters,
    expireAccessTokens: () => accessTokens.clear(),
    close: () =>
      new Promise((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
