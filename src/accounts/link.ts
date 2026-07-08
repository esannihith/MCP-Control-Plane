import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Db } from "../db/index.js";
import type { Vault } from "../vault/index.js";
import type { UpstreamRow } from "../upstream/registry.js";
import { deleteAccount, upsertAccount, type LinkedAccount } from "./index.js";
import { AccountOAuthProvider } from "./provider.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

export interface LinkOptions {
  label: string;
  /** Delivers the authorization URL to the user (print it, open a browser, or fetch it in tests). */
  openUrl: (url: URL) => void | Promise<void>;
  callbackPort?: number;
  timeoutMs?: number;
}

/**
 * Interactively links an account at an OAuth-protected upstream:
 * runs discovery → DCR → authorization-code + PKCE via a loopback callback
 * listener, stores the resulting tokens in the vault, and verifies the
 * credentials with a fresh connection before reporting success.
 */
/**
 * The upstream's DCR registration pins our redirect_uri, so later links must
 * reuse the port the client was registered with or the AS rejects them.
 */
function registeredCallbackPort(db: Db, vault: Vault, upstreamId: number): number | undefined {
  const row = db.prepare("SELECT oauth_client_info_enc FROM upstreams WHERE id = ?").get(upstreamId) as
    | { oauth_client_info_enc: string | null }
    | undefined;
  if (!row?.oauth_client_info_enc) return undefined;
  try {
    const info = JSON.parse(vault.decrypt(row.oauth_client_info_enc)) as { redirect_uris?: string[] };
    const url = new URL(info.redirect_uris?.[0] ?? "");
    if (url.hostname === "127.0.0.1" && url.pathname === "/callback") return Number(url.port);
  } catch {
    return undefined;
  }
  return undefined;
}

export async function linkAccount(db: Db, vault: Vault, upstream: UpstreamRow, options: LinkOptions): Promise<LinkedAccount> {
  const account = upsertAccount(db, upstream.id, options.label);
  const wasLinked = account.linked;

  const preferredPort = options.callbackPort ?? registeredCallbackPort(db, vault, upstream.id) ?? 0;
  const httpServer = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(preferredPort, "127.0.0.1", resolve);
    });
  } catch {
    // Registered port unavailable: drop the stale client registration and
    // re-register on a fresh port. Accounts linked under the old client_id
    // may need re-linking once their refresh tokens stop working.
    console.warn(`Callback port ${preferredPort} unavailable — re-registering OAuth client for '${upstream.name}'.`);
    db.prepare("UPDATE upstreams SET oauth_client_info_enc = NULL WHERE id = ?").run(upstream.id);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  }
  const { port } = httpServer.address() as AddressInfo;
  const redirectUrl = `http://127.0.0.1:${port}/callback`;

  const authorizationCode = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for the OAuth callback")),
      options.timeoutMs ?? 5 * 60 * 1000,
    );
    httpServer.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUrl);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" }).end(
        code
          ? "<h3>Account linked. You can close this tab.</h3>"
          : `<h3>Authorization failed: ${error ?? "no code returned"}</h3>`,
      );
      clearTimeout(timer);
      if (code) resolve(code);
      else reject(new Error(`Authorization failed: ${error ?? "no code returned"}`));
    });
  });

  const provider = new AccountOAuthProvider({
    db,
    vault,
    upstreamId: upstream.id,
    accountId: account.id,
    redirectUrl,
    onRedirect: options.openUrl,
  });

  try {
    const client = new Client({ name: SERVER_NAME, version: SERVER_VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(upstream.url), { authProvider: provider });
    try {
      await client.connect(transport);
      await client.close();
      return { ...account, linked: true };
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
    }

    const code = await authorizationCode;
    await transport.finishAuth(code);
    await transport.close().catch(() => {});

    // Verify the stored credentials actually work before declaring victory.
    const verifyClient = new Client({ name: SERVER_NAME, version: SERVER_VERSION });
    await verifyClient.connect(
      new StreamableHTTPClientTransport(new URL(upstream.url), { authProvider: provider }),
    );
    await verifyClient.close();
    return { ...account, linked: true };
  } catch (error) {
    if (!wasLinked) deleteAccount(db, upstream.id, options.label);
    throw error;
  } finally {
    httpServer.closeAllConnections();
    httpServer.close();
  }
}
