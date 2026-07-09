import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Db } from "../db/index.js";
import { verifyOwnerPassword } from "./owner.js";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 10 * 60;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export interface PendingFlow {
  id: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
}

/**
 * The control plane's own OAuth 2.1 authorization server (toward MCP clients
 * like claude.ai/ChatGPT). The SDK's mcpAuthRouter does protocol validation
 * and PKCE; this provider owns storage and the consent decision. Every
 * approved grant becomes a connection row in api_keys, so bindings, sessions,
 * and (later) audit treat OAuth clients exactly like header API keys.
 */
export class ControlPlaneAuthProvider implements OAuthServerProvider {
  /** Consent flows are short-lived and single-process; memory is fine. */
  private flows = new Map<string, PendingFlow>();

  constructor(private db: Db) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const db = this.db;
    return {
      getClient(clientId: string): OAuthClientInformationFull | undefined {
        const row = db.prepare("SELECT data FROM oauth_clients WHERE client_id = ?").get(clientId) as
          | { data: string }
          | undefined;
        return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
      },
      registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
        db.prepare("INSERT INTO oauth_clients (client_id, data) VALUES (?, ?)").run(
          client.client_id,
          JSON.stringify(client),
        );
        return client;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = randomBytes(16).toString("hex");
    this.flows.set(id, { id, client, params, createdAt: nowSeconds() });
    for (const flow of this.flows.values()) {
      if (nowSeconds() - flow.createdAt > CODE_TTL_SECONDS) this.flows.delete(flow.id);
    }
    res.redirect(`/oauth/consent?flow=${id}`);
  }

  getFlow(id: string): PendingFlow | undefined {
    const flow = this.flows.get(id);
    if (!flow || nowSeconds() - flow.createdAt > CODE_TTL_SECONDS) return undefined;
    return flow;
  }

  /** Consent decision → the redirect URL to send the user's browser to. */
  completeFlow(flowId: string, decision: { approve: boolean; password: string }): URL {
    const flow = this.getFlow(flowId);
    if (!flow) throw new Error("Unknown or expired consent flow — restart authorization from your client");
    const redirect = new URL(flow.params.redirectUri);

    if (!decision.approve) {
      this.flows.delete(flowId);
      redirect.searchParams.set("error", "access_denied");
      if (flow.params.state) redirect.searchParams.set("state", flow.params.state);
      return redirect;
    }

    if (!verifyOwnerPassword(this.db, decision.password)) {
      throw new InvalidPasswordError();
    }
    this.flows.delete(flowId);

    const keyId = this.connectionForClient(flow.client);

    const code = `ac_${randomBytes(24).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO oauth_codes (code_hash, client_id, api_key_id, code_challenge, redirect_uri, scopes, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(code),
        flow.client.client_id,
        keyId,
        flow.params.codeChallenge,
        flow.params.redirectUri,
        (flow.params.scopes ?? []).join(" "),
        nowSeconds() + CODE_TTL_SECONDS,
      );

    redirect.searchParams.set("code", code);
    if (flow.params.state) redirect.searchParams.set("state", flow.params.state);
    return redirect;
  }

  /**
   * Re-authorizations from the same registered client reuse its connection
   * row, so bindings and profile assignments survive token-refresh failures
   * and connector re-auth. Fresh clients get a readable unique name.
   */
  private connectionForClient(client: OAuthClientInformationFull): number {
    const existing = this.db
      .prepare("SELECT id FROM api_keys WHERE oauth_client_id = ? AND revoked_at IS NULL")
      .get(client.client_id) as { id: number } | undefined;
    if (existing) return existing.id;

    const base = `oauth:${(client.client_name ?? client.client_id).slice(0, 40)}`;
    let name = base;
    for (let i = 2; this.db.prepare("SELECT 1 FROM api_keys WHERE name = ?").get(name); i++) {
      name = `${base}-${i}`;
    }
    // Random hash: this connection row can never be used as a header API key.
    return Number(
      this.db
        .prepare("INSERT INTO api_keys (name, key_hash, oauth_client_id) VALUES (?, ?, ?)")
        .run(name, sha256(randomBytes(32).toString("hex")), client.client_id).lastInsertRowid,
    );
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = this.db
      .prepare("SELECT code_challenge FROM oauth_codes WHERE code_hash = ? AND client_id = ? AND expires_at > ?")
      .get(sha256(authorizationCode), client.client_id, nowSeconds()) as { code_challenge: string } | undefined;
    if (!row) throw new InvalidGrantError("Unknown or expired authorization code");
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const codeHash = sha256(authorizationCode);
    const row = this.db
      .prepare("SELECT api_key_id, redirect_uri, scopes, expires_at FROM oauth_codes WHERE code_hash = ? AND client_id = ?")
      .get(codeHash, client.client_id) as
      | { api_key_id: number; redirect_uri: string; scopes: string; expires_at: number }
      | undefined;
    this.db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(codeHash); // single use
    if (!row || row.expires_at <= nowSeconds()) throw new InvalidGrantError("Unknown or expired authorization code");
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidRequestError("redirect_uri mismatch");
    return this.issueTokens(client.client_id, row.api_key_id, row.scopes);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const row = this.db
      .prepare(
        `SELECT token_hash, api_key_id FROM oauth_tokens
         WHERE token_hash = ? AND kind = 'refresh' AND client_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(sha256(refreshToken), client.client_id, nowSeconds()) as
      | { token_hash: string; api_key_id: number }
      | undefined;
    if (!row) throw new InvalidGrantError("Unknown, expired, or revoked refresh token");
    // Rotate: the presented refresh token dies with this exchange.
    this.db.prepare("UPDATE oauth_tokens SET revoked_at = datetime('now') WHERE token_hash = ?").run(row.token_hash);
    return this.issueTokens(client.client_id, row.api_key_id, "");
  }

  private issueTokens(clientId: string, apiKeyId: number, scopes: string): OAuthTokens {
    const accessToken = `at_${randomBytes(24).toString("hex")}`;
    const refreshToken = `rt_${randomBytes(24).toString("hex")}`;
    const insert = this.db.prepare(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, api_key_id, expires_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(sha256(accessToken), "access", clientId, apiKeyId, nowSeconds() + ACCESS_TOKEN_TTL_SECONDS);
    insert.run(sha256(refreshToken), "refresh", clientId, apiKeyId, nowSeconds() + REFRESH_TOKEN_TTL_SECONDS);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      ...(scopes ? { scope: scopes } : {}),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.db
      .prepare(
        `SELECT t.client_id, t.api_key_id, t.expires_at, k.name AS key_name
         FROM oauth_tokens t JOIN api_keys k ON k.id = t.api_key_id
         WHERE t.token_hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL
           AND t.expires_at > ? AND k.revoked_at IS NULL`,
      )
      .get(sha256(token), nowSeconds()) as
      | { client_id: string; api_key_id: number; expires_at: number; key_name: string }
      | undefined;
    if (!row) throw new InvalidGrantError("Invalid or expired access token");
    return {
      token,
      clientId: row.client_id,
      scopes: [],
      expiresAt: row.expires_at,
      extra: { apiKeyId: row.api_key_id, keyName: row.key_name },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    this.db
      .prepare("UPDATE oauth_tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND client_id = ?")
      .run(sha256(request.token), client.client_id);
  }
}

export class InvalidPasswordError extends Error {
  constructor() {
    super("Incorrect password");
  }
}
