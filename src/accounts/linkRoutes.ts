import { Router } from "express";
import type { UpstreamManager } from "../upstream/manager.js";
import type { ServerLinkManager } from "./serverLink.js";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
   <style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;background:#f5f5f4}
   div{background:#fff;border:1px solid #ddd;border-radius:10px;padding:2rem;max-width:26rem}
   .ok{color:#15803d}.err{color:#b91c1c}</style></head><body><div>${body}</div></body></html>`;

/**
 * The vendor-facing half of browser-driven account linking. Both routes are
 * deliberately session-free: the vendor's redirect is a cross-site navigation,
 * and /link/<id> is the handle for completing a flow in another browser or an
 * incognito window (all flow state, incl. the PKCE verifier, lives server-side).
 */
export function createLinkRoutes(serverLink: ServerLinkManager | null, manager: UpstreamManager): Router {
  const router = Router();

  router.get("/link/:flowId", (req, res) => {
    const flow = serverLink?.getFlow(String(req.params.flowId));
    if (!flow) {
      res
        .status(410)
        .send(page("Link expired", `<p class="err">This link flow expired or was superseded — start again from the app.</p>`));
      return;
    }
    res.redirect(flow.authorizeUrl.toString());
  });

  router.get("/upstream-callback", async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;
    if (!serverLink) {
      res.status(503).send(page("Link failed", `<p class="err">Vault not configured (CP_MASTER_KEY).</p>`));
      return;
    }
    if (error || !code || !state) {
      res
        .status(400)
        .send(page("Link failed", `<p class="err">Authorization failed: ${escapeHtml(error ?? "no code returned")}</p>`));
      return;
    }
    try {
      const linked = await serverLink.complete(state, code);
      await manager.refreshUpstream(linked.upstream);
      res.send(
        page(
          "Account linked",
          `<h1 class="ok">Linked '${escapeHtml(linked.label)}' at '${escapeHtml(linked.upstream)}'</h1>
           <p>Tools are being ingested. You can close this tab.</p>`,
        ),
      );
    } catch (linkError) {
      res
        .status(400)
        .send(page("Link failed", `<p class="err">${escapeHtml(linkError instanceof Error ? linkError.message : String(linkError))}</p>`));
    }
  });

  return router;
}
