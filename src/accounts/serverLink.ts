import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Db } from "../db/index.js";
import type { Vault } from "../vault/index.js";
import { listUpstreams, type UpstreamRow } from "../upstream/registry.js";
import { deleteAccount, upsertAccount } from "./index.js";
import { AccountOAuthProvider } from "./provider.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

const FLOW_TTL_MS = 10 * 60 * 1000;

interface PendingLink {
  id: string;
  upstream: UpstreamRow;
  accountId: number;
  label: string;
  wasLinked: boolean;
  transport: StreamableHTTPClientTransport;
  provider: AccountOAuthProvider;
  createdAt: number;
}

/**
 * Browser-driven account linking for remote deployments, where the CLI's
 * loopback callback can't work (the browser and the control plane are on
 * different machines). The vendor redirects to `${publicUrl}/upstream-callback`;
 * the flow id travels in the OAuth state parameter.
 */
export class ServerLinkManager {
  private flows = new Map<string, PendingLink>();

  constructor(
    private db: Db,
    private vault: Vault,
    private publicUrl: string,
  ) {}

  get callbackUrl(): string {
    return `${this.publicUrl}/upstream-callback`;
  }

  /** Starts a link flow; returns the vendor authorization URL to send the browser to. */
  async begin(upstreamName: string, label: string): Promise<URL> {
    const upstream = listUpstreams(this.db, true).find((u) => u.name === upstreamName);
    if (!upstream) throw new Error(`Unknown upstream '${upstreamName}'`);
    if (upstream.auth_mode !== "oauth") throw new Error(`Upstream '${upstreamName}' does not use OAuth`);

    // A client registration pinned to a different redirect_uri (e.g. a CLI
    // loopback) would make the vendor reject us — re-register in that case.
    const stored = this.db
      .prepare("SELECT oauth_client_info_enc FROM upstreams WHERE id = ?")
      .get(upstream.id) as { oauth_client_info_enc: string | null };
    if (stored.oauth_client_info_enc) {
      try {
        const info = JSON.parse(this.vault.decrypt(stored.oauth_client_info_enc)) as { redirect_uris?: string[] };
        if (!info.redirect_uris?.includes(this.callbackUrl)) {
          this.db.prepare("UPDATE upstreams SET oauth_client_info_enc = NULL WHERE id = ?").run(upstream.id);
        }
      } catch {
        this.db.prepare("UPDATE upstreams SET oauth_client_info_enc = NULL WHERE id = ?").run(upstream.id);
      }
    }

    const account = upsertAccount(this.db, upstream.id, label);
    const flowId = randomBytes(16).toString("hex");
    const authorizationUrl = new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Vendor did not request authorization")), 15_000);
      const provider = new AccountOAuthProvider({
        db: this.db,
        vault: this.vault,
        upstreamId: upstream.id,
        accountId: account.id,
        redirectUrl: this.callbackUrl,
        stateValue: flowId,
        onRedirect: (url) => {
          clearTimeout(timer);
          resolve(url);
        },
      });
      const transport = new StreamableHTTPClientTransport(new URL(upstream.url), { authProvider: provider });
      this.flows.set(flowId, {
        id: flowId,
        upstream,
        accountId: account.id,
        label,
        wasLinked: account.linked,
        transport,
        provider,
        createdAt: Date.now(),
      });
      const client = new Client({ name: SERVER_NAME, version: SERVER_VERSION });
      client
        .connect(transport)
        .then(() => {
          // Tokens were still valid — nothing to authorize.
          clearTimeout(timer);
          this.flows.delete(flowId);
          void client.close();
          reject(new AlreadyLinkedError(label));
        })
        .catch((error) => {
          if (!(error instanceof UnauthorizedError)) {
            clearTimeout(timer);
            this.cleanupFlow(flowId);
            reject(error);
          }
          // UnauthorizedError: onRedirect has resolved (or will) with the URL.
        });
    });

    this.pruneExpired();
    try {
      return await authorizationUrl;
    } catch (error) {
      this.cleanupFlow(flowId);
      throw error;
    }
  }

  /** Completes a flow from the vendor's redirect; returns the linked label. */
  async complete(flowId: string, code: string): Promise<{ upstream: string; label: string }> {
    const flow = this.flows.get(flowId);
    if (!flow || Date.now() - flow.createdAt > FLOW_TTL_MS) {
      throw new Error("Unknown or expired link flow — start again from the dashboard");
    }
    this.flows.delete(flowId);
    try {
      await flow.transport.finishAuth(code);
      await flow.transport.close().catch(() => {});
      // Verify the stored credentials before reporting success.
      const verify = new Client({ name: SERVER_NAME, version: SERVER_VERSION });
      await verify.connect(
        new StreamableHTTPClientTransport(new URL(flow.upstream.url), { authProvider: flow.provider }),
      );
      await verify.close();
      return { upstream: flow.upstream.name, label: flow.label };
    } catch (error) {
      if (!flow.wasLinked) deleteAccount(this.db, flow.upstream.id, flow.label);
      throw error;
    }
  }

  private cleanupFlow(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    this.flows.delete(flowId);
    void flow.transport.close().catch(() => {});
    if (!flow.wasLinked) deleteAccount(this.db, flow.upstream.id, flow.label);
  }

  private pruneExpired(): void {
    for (const flow of this.flows.values()) {
      if (Date.now() - flow.createdAt > FLOW_TTL_MS) this.cleanupFlow(flow.id);
    }
  }
}

export class AlreadyLinkedError extends Error {
  constructor(label: string) {
    super(`Account '${label}' is already linked and its tokens still work — nothing to authorize`);
  }
}
