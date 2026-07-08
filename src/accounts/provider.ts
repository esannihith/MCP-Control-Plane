import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Db } from "../db/index.js";
import type { Vault } from "../vault/index.js";
import { getAccountTokens, saveAccountTokens } from "./index.js";
import { SERVER_NAME } from "../version.js";

export interface AccountProviderOptions {
  db: Db;
  vault: Vault;
  upstreamId: number;
  accountId: number;
  /** Loopback callback URL during interactive linking; absent in headless (server) use. */
  redirectUrl?: string;
  /** Delivers the authorization URL to the user. Absent → headless: authorization attempts fail loudly. */
  onRedirect?: (url: URL) => void | Promise<void>;
}

/**
 * OAuthClientProvider backed by the control plane's DB + vault.
 * Tokens live on the linked account; the DCR client registration lives on the
 * upstream (shared by all of that upstream's accounts). The code verifier is
 * kept in memory — it only matters within a single interactive link flow.
 */
export class AccountOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined;

  constructor(private readonly opts: AccountProviderOptions) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl ?? "http://127.0.0.1/unused-headless-callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: SERVER_NAME,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const row = this.opts.db
      .prepare("SELECT oauth_client_info_enc FROM upstreams WHERE id = ?")
      .get(this.opts.upstreamId) as { oauth_client_info_enc: string | null } | undefined;
    if (!row?.oauth_client_info_enc) return undefined;
    return JSON.parse(this.opts.vault.decrypt(row.oauth_client_info_enc)) as OAuthClientInformationMixed;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.opts.db
      .prepare("UPDATE upstreams SET oauth_client_info_enc = ? WHERE id = ?")
      .run(this.opts.vault.encrypt(JSON.stringify(info)), this.opts.upstreamId);
  }

  tokens(): OAuthTokens | undefined {
    return getAccountTokens(this.opts.db, this.opts.vault, this.opts.accountId);
  }

  saveTokens(tokens: OAuthTokens): void {
    saveAccountTokens(this.opts.db, this.opts.vault, this.opts.accountId, tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.opts.onRedirect) {
      throw new Error("Interactive authorization required — re-link this account (npm run account -- link)");
    }
    await this.opts.onRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("No code verifier: no authorization flow is in progress");
    return this.verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all" || scope === "tokens") {
      this.opts.db.prepare("UPDATE linked_accounts SET tokens_enc = NULL WHERE id = ?").run(this.opts.accountId);
    }
    if (scope === "all" || scope === "client") {
      this.opts.db
        .prepare("UPDATE upstreams SET oauth_client_info_enc = NULL WHERE id = ?")
        .run(this.opts.upstreamId);
    }
  }
}
