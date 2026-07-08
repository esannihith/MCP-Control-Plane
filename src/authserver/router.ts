import express, { Router } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { hasOwnerPassword } from "./owner.js";
import { ControlPlaneAuthProvider, InvalidPasswordError, type PendingFlow } from "./provider.js";
import { SERVER_NAME } from "../version.js";

export interface AuthServer {
  router: Router;
  provider: ControlPlaneAuthProvider;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function consentPage(flow: PendingFlow, error?: string): string {
  const clientName = escapeHtml(String(flow.client.client_name ?? flow.client.client_id));
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorize — MCP Control Plane</title>
<style>
  body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; background: #f5f5f4; }
  form { background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 2rem; max-width: 22rem; }
  h1 { font-size: 1.1rem; } p { color: #444; font-size: .92rem; }
  input[type=password] { width: 100%; padding: .5rem; margin: .6rem 0 1rem; box-sizing: border-box; }
  button { padding: .5rem 1.1rem; border-radius: 6px; border: 1px solid #888; background: #fff; cursor: pointer; }
  button[value=approve] { background: #1a7f37; border-color: #1a7f37; color: #fff; }
  .error { color: #b91c1c; font-size: .9rem; }
</style></head><body>
<form method="post" action="/oauth/consent">
  <h1>Authorize client</h1>
  <p><strong>${clientName}</strong> wants to connect to your MCP control plane. It will be able to call the tools your profile exposes, as the accounts this connection gets bound to.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <input type="hidden" name="flow" value="${escapeHtml(flow.id)}">
  <label>Owner password<br><input type="password" name="password" autofocus autocomplete="current-password"></label>
  <button type="submit" name="action" value="approve">Approve</button>
  <button type="submit" name="action" value="deny">Deny</button>
</form></body></html>`;
}

export function createAuthServer(db: Db, config: Config): AuthServer {
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

  router.get("/oauth/consent", (req, res) => {
    const flow = provider.getFlow(String(req.query.flow ?? ""));
    if (!flow) {
      res.status(400).send("Unknown or expired consent flow — restart authorization from your client.");
      return;
    }
    if (!hasOwnerPassword(db)) {
      res
        .status(503)
        .send("No owner password is set. Run: npm run owner -- set-password, then restart authorization.");
      return;
    }
    res.type("html").send(consentPage(flow));
  });

  router.post("/oauth/consent", express.urlencoded({ extended: false }), (req, res) => {
    const { flow: flowId, password, action } = req.body as Record<string, string>;
    try {
      const redirect = provider.completeFlow(String(flowId ?? ""), {
        approve: action === "approve",
        password: String(password ?? ""),
      });
      res.redirect(redirect.toString());
    } catch (error) {
      const flow = provider.getFlow(String(flowId ?? ""));
      if (error instanceof InvalidPasswordError && flow) {
        res.status(401).type("html").send(consentPage(flow, "Incorrect password — try again."));
        return;
      }
      res.status(400).send(error instanceof Error ? error.message : "Authorization failed");
    }
  });

  return { router, provider };
}
