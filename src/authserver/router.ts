import express, { Router } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { getUserById, type User } from "../auth/users.js";
import type { UserSessionStore } from "../auth/userSessions.js";
import { ControlPlaneAuthProvider, type PendingFlow } from "./provider.js";
import { SERVER_NAME } from "../version.js";

export interface AuthServer {
  router: Router;
  provider: ControlPlaneAuthProvider;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function consentPage(flow: PendingFlow, user: User, csrf: string): string {
  const clientName = escapeHtml(String(flow.client.client_name ?? flow.client.client_id));
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorize — MCP Control Plane</title>
<style>
  body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; background: #f5f5f4; }
  form { background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 2rem; max-width: 24rem; }
  h1 { font-size: 1.1rem; } p { color: #444; font-size: .92rem; }
  .who { color: #666; font-size: .85rem; margin-bottom: 1rem; }
  input[type=text] { width: 100%; padding: .5rem; margin: .4rem 0 1rem; box-sizing: border-box; }
  button { padding: .5rem 1.1rem; border-radius: 6px; border: 1px solid #888; background: #fff; cursor: pointer; }
  button[value=approve] { background: #1a7f37; border-color: #1a7f37; color: #fff; }
</style></head><body>
<form method="post" action="/oauth/consent">
  <h1>Authorize client</h1>
  <p class="who">Signed in as <strong>${escapeHtml(user.email)}</strong></p>
  <p><strong>${clientName}</strong> wants to connect to your MCP control plane. It will be able to call the tools your permissions expose, as the accounts this connection gets bound to.</p>
  <input type="hidden" name="flow" value="${escapeHtml(flow.id)}">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <button type="submit" name="action" value="approve">Approve</button>
  <button type="submit" name="action" value="deny">Deny</button>
</form></body></html>`;
}

export function createAuthServer(db: Db, config: Config, sessions: UserSessionStore): AuthServer {
  const provider = new ControlPlaneAuthProvider(db);
  const router = Router();

  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicUrl),
      resourceServerUrl: new URL(`${config.publicUrl}/mcp`),
      resourceName: SERVER_NAME,
    }),
  );

  // Consent requires a signed-in Google user; the approved connection belongs to them.
  router.get("/oauth/consent", (req, res) => {
    const flow = provider.getFlow(String(req.query.flow ?? ""));
    if (!flow) {
      res.status(400).send("Unknown or expired consent flow — restart authorization from your client.");
      return;
    }
    const session = sessions.get(req);
    const user = session ? getUserById(db, session.userId) : null;
    if (!session || !user) {
      res.redirect(`/auth/google?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    res.type("html").send(consentPage(flow, user, session.csrf));
  });

  router.post("/oauth/consent", express.urlencoded({ extended: false }), (req, res) => {
    const { flow: flowId, action, csrf } = req.body as Record<string, string>;
    const session = sessions.get(req);
    if (!session || csrf !== session.csrf) {
      res.status(403).send("Session expired — reload the consent page and try again.");
      return;
    }
    try {
      const redirect = provider.completeFlow(String(flowId ?? ""), {
        approve: action === "approve",
        userId: session.userId,
      });
      res.redirect(redirect.toString());
    } catch (error) {
      res.status(400).send(error instanceof Error ? error.message : "Authorization failed");
    }
  });

  return { router, provider };
}
