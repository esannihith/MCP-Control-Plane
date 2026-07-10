import express, { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import type { Vault } from "../vault/index.js";
import type { UpstreamManager } from "../upstream/manager.js";
import { hasOwnerPassword, verifyOwnerPassword } from "../authserver/owner.js";
import { deleteAccount, listAccounts } from "../accounts/index.js";
import { AlreadyLinkedError, ServerLinkManager } from "../accounts/serverLink.js";
import { listAudit } from "../audit.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../keys.js";
import {
  addRule,
  assignProfile,
  createProfile,
  deleteProfile,
  getProfileByName,
  listProfiles,
  removeRule,
} from "../profiles.js";
import { addUpstream, listUpstreams, removeUpstream } from "../upstream/registry.js";
import { SessionStore } from "./session.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

export interface DashboardDeps {
  db: Db;
  vault: Vault | null;
  manager: UpstreamManager;
  config: Config;
}

const esc = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const page = (title: string, body: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — MCP Control Plane</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 64rem; padding: 0 1rem; color: #1c1917; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 2.2rem; border-bottom: 1px solid #e7e5e4; padding-bottom: .3rem; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #f0efee; vertical-align: top; }
  th { color: #78716c; font-weight: 600; }
  form.inline { display: inline; } input, select { padding: .3rem .4rem; margin-right: .3rem; }
  button { padding: .3rem .8rem; cursor: pointer; border: 1px solid #a8a29e; border-radius: 5px; background: #fafaf9; }
  button.danger { border-color: #dc2626; color: #dc2626; }
  .msg { background: #ecfdf5; border: 1px solid #10b981; padding: .5rem .8rem; border-radius: 6px; }
  .err { background: #fef2f2; border: 1px solid #dc2626; padding: .5rem .8rem; border-radius: 6px; }
  .ok { color: #15803d; } .bad { color: #b91c1c; } code { background: #f5f5f4; padding: .1rem .3rem; border-radius: 3px; }
  .keyonce { font-size: 1.05rem; background: #fffbeb; border: 1px solid #f59e0b; padding: .7rem; border-radius: 6px; word-break: break-all; }
</style></head><body>${body}</body></html>`;

export function createDashboard(deps: DashboardDeps): Router {
  const { db, vault, manager, config } = deps;
  const sessions = new SessionStore(config.publicUrl.startsWith("https:"));
  const serverLink = vault ? new ServerLinkManager(db, vault, config.publicUrl) : null;
  const router = Router();
  const form = express.urlencoded({ extended: false });

  const redirectMsg = (res: Response, msg: string, isError = false): void =>
    res.redirect(`/dashboard?${isError ? "err" : "msg"}=${encodeURIComponent(msg)}`);

  router.get("/dashboard/login", (_req, res) => {
    if (!hasOwnerPassword(db)) {
      res
        .status(503)
        .send(
          page(
            "Setup required",
            "<h1>No owner password set</h1><p>Set one via <code>npm run owner -- set-password</code> or the <code>CP_OWNER_PASSWORD</code> environment variable, then reload.</p>",
          ),
        );
      return;
    }
    res.send(
      page(
        "Log in",
        `<h1>MCP Control Plane</h1>
         <form method="post" action="/dashboard/login">
           <label>Owner password <input type="password" name="password" autofocus></label>
           <button type="submit">Log in</button>
         </form>`,
      ),
    );
  });

  router.post("/dashboard/login", form, (req, res) => {
    if (!verifyOwnerPassword(db, String((req.body as { password?: string })?.password ?? ""))) {
      res.status(401).send(page("Log in", `<p class="err">Wrong password.</p><p><a href="/dashboard/login">Try again</a></p>`));
      return;
    }
    sessions.create(res);
    res.redirect("/dashboard");
  });

  router.post("/dashboard/logout", form, (req, res) => {
    sessions.destroy(req, res);
    res.redirect("/dashboard/login");
  });

  router.get("/dashboard", sessions.requireSession(), (req, res) => {
    res.send(page("Dashboard", overview(deps, res.locals.dashSession.csrf, req)));
  });

  // ---- mutations (dashboard-only; the MCP surface has no equivalents) ----
  const guard = [form, sessions.requireCsrf()] as const;

  router.post("/dashboard/upstreams/add", ...guard, async (req, res) => {
    const { name, url, authMode, bearer } = req.body as Record<string, string>;
    if (!name || !url) return redirectMsg(res, "Upstream name and URL are required", true);
    try {
      const bearerToken = authMode === "bearer" ? (vault ? vault.encrypt(bearer ?? "") : bearer) : undefined;
      addUpstream(db, name, url, { bearerToken, oauth: authMode === "oauth" });
      if (authMode !== "oauth") await manager.refreshUpstream(name);
      redirectMsg(res, `Upstream '${name}' added${authMode === "oauth" ? " — link an account below" : ""}`);
    } catch (error) {
      redirectMsg(res, error instanceof Error ? error.message : "Failed to add upstream", true);
    }
  });

  router.post("/dashboard/upstreams/remove", ...guard, (req, res) => {
    const { name } = req.body as Record<string, string>;
    redirectMsg(res, removeUpstream(db, name) ? `Upstream '${name}' removed` : `No upstream '${name}'`, !name);
  });

  router.post("/dashboard/accounts/link", ...guard, async (req, res) => {
    const { upstream, label } = req.body as Record<string, string>;
    if (!serverLink) return redirectMsg(res, "CP_MASTER_KEY is not set — vault required for OAuth", true);
    try {
      const authorizeUrl = await serverLink.begin(upstream, label || "default");
      res.redirect(authorizeUrl.toString());
    } catch (error) {
      const message = error instanceof AlreadyLinkedError ? error.message : `Link failed: ${error instanceof Error ? error.message : error}`;
      redirectMsg(res, message, !(error instanceof AlreadyLinkedError));
    }
  });

  router.post("/dashboard/accounts/unlink", ...guard, (req, res) => {
    const { upstream, label } = req.body as Record<string, string>;
    const row = listUpstreams(db).find((u) => u.name === upstream);
    const removed = row ? deleteAccount(db, row.id, label) : false;
    redirectMsg(res, removed ? `Unlinked '${label}' from '${upstream}'` : "No such account", !removed);
  });

  router.post("/dashboard/keys/create", ...guard, (req, res) => {
    const { name } = req.body as Record<string, string>;
    if (!name) return redirectMsg(res, "Key name required", true);
    try {
      const { key } = createApiKey(db, name);
      res.send(
        page(
          "API key created",
          `<h1>API key '${esc(name)}' created</h1>
           <p>Shown <strong>once</strong> — store it now:</p>
           <p class="keyonce"><code>${esc(key)}</code></p>
           <p>Client header: <code>Authorization: Bearer ${esc(key)}</code></p>
           <p><a href="/dashboard">Back to dashboard</a></p>`,
        ),
      );
    } catch {
      redirectMsg(res, `A key named '${name}' already exists`, true);
    }
  });

  router.post("/dashboard/keys/revoke", ...guard, (req, res) => {
    const { name } = req.body as Record<string, string>;
    redirectMsg(res, revokeApiKey(db, name) ? `Key '${name}' revoked` : `No active key '${name}'`, false);
  });

  router.post("/dashboard/profiles/create", ...guard, (req, res) => {
    const { name } = req.body as Record<string, string>;
    if (!name) return redirectMsg(res, "Profile name required", true);
    try {
      createProfile(db, name);
      redirectMsg(res, `Profile '${name}' created — it allows nothing until rules are added`);
    } catch {
      redirectMsg(res, `Profile '${name}' already exists`, true);
    }
  });

  router.post("/dashboard/profiles/delete", ...guard, (req, res) => {
    const { name } = req.body as Record<string, string>;
    redirectMsg(res, deleteProfile(db, name) ? `Profile '${name}' deleted` : `No profile '${name}'`, false);
  });

  router.post("/dashboard/profiles/allow", ...guard, (req, res) => {
    const { profile, upstream, pattern } = req.body as Record<string, string>;
    const p = getProfileByName(db, profile);
    if (!p || !upstream) return redirectMsg(res, "Profile and upstream required", true);
    addRule(db, p.id, upstream, pattern || "*");
    redirectMsg(res, `Rule added to '${profile}'`);
  });

  router.post("/dashboard/profiles/disallow", ...guard, (req, res) => {
    const { profile, upstream, pattern } = req.body as Record<string, string>;
    const p = getProfileByName(db, profile);
    if (!p) return redirectMsg(res, "No such profile", true);
    redirectMsg(res, removeRule(db, p.id, upstream, pattern || "*") ? "Rule removed" : "No such rule", false);
  });

  router.post("/dashboard/profiles/assign", ...guard, (req, res) => {
    const { key, profile } = req.body as Record<string, string>;
    if (profile === "") {
      redirectMsg(res, assignProfile(db, key, null) ? `'${key}' is now unrestricted` : `No connection '${key}'`, false);
      return;
    }
    const p = getProfileByName(db, profile);
    if (!p) return redirectMsg(res, `No profile '${profile}'`, true);
    redirectMsg(res, assignProfile(db, key, p.id) ? `'${key}' now uses '${profile}'` : `No connection '${key}'`, false);
  });

  // ---- vendor OAuth callback (session-free: reached via cross-site redirect,
  // possibly in an incognito window; the flow id in `state` correlates it) ----
  router.get("/upstream-callback", async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;
    if (!serverLink) {
      res.status(503).send(page("Link failed", `<p class="err">Vault not configured.</p>`));
      return;
    }
    if (error || !code || !state) {
      res.status(400).send(page("Link failed", `<p class="err">Authorization failed: ${esc(error ?? "no code returned")}</p>`));
      return;
    }
    try {
      const linked = await serverLink.complete(state, code);
      await manager.refreshUpstream(linked.upstream);
      res.send(
        page(
          "Account linked",
          `<h1 class="ok">Linked '${esc(linked.label)}' at '${esc(linked.upstream)}'</h1>
           <p>Tools are being ingested. You can close this tab.</p>`,
        ),
      );
    } catch (linkError) {
      res
        .status(400)
        .send(page("Link failed", `<p class="err">${esc(linkError instanceof Error ? linkError.message : linkError)}</p>`));
    }
  });

  return router;
}

function overview(deps: DashboardDeps, csrf: string, req: Request): string {
  const { db, manager } = deps;
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const msg = typeof req.query.msg === "string" ? `<p class="msg">${esc(req.query.msg)}</p>` : "";
  const err = typeof req.query.err === "string" ? `<p class="err">${esc(req.query.err)}</p>` : "";

  const upstreams = manager.status();
  const upstreamRows = listUpstreams(db)
    .map((u) => {
      const status = upstreams.find((s) => s.name === u.name);
      const accounts = listAccounts(db, u.id).filter((a) => a.linked);
      const accountCells = accounts
        .map(
          (a) =>
            `${esc(a.label)} <form class="inline" method="post" action="/dashboard/accounts/unlink">${hidden}<input type="hidden" name="upstream" value="${esc(u.name)}"><input type="hidden" name="label" value="${esc(a.label)}"><button class="danger">unlink</button></form>`,
        )
        .join("<br>");
      const linkForm =
        u.auth_mode === "oauth"
          ? `<form class="inline" method="post" action="/dashboard/accounts/link">${hidden}<input type="hidden" name="upstream" value="${esc(u.name)}"><input name="label" placeholder="label (e.g. you@x.com)" size="18"><button>link account</button></form>`
          : "";
      return `<tr>
        <td><strong>${esc(u.name)}</strong><br><code>${esc(u.url)}</code></td>
        <td>${esc(u.auth_mode)}</td>
        <td class="${status?.connected ? "ok" : "bad"}">${status?.connected ? "connected" : "disconnected"} · ${status?.toolCount ?? 0} tools</td>
        <td>${accountCells || "—"}<br>${linkForm}</td>
        <td><form class="inline" method="post" action="/dashboard/upstreams/remove">${hidden}<input type="hidden" name="name" value="${esc(u.name)}"><button class="danger">remove</button></form></td>
      </tr>`;
    })
    .join("");

  const profiles = listProfiles(db);
  const profileOptions = profiles.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
  const keyRows = listApiKeys(db)
    .filter((k) => !k.revokedAt)
    .map((k) => {
      const profileName = getConnectionProfileName(deps.db, k.id);
      return `<tr><td>${esc(k.name)}</td><td>${esc(k.createdAt)}</td><td>${esc(profileName ?? "(unrestricted)")}</td>
        <td>
          <form class="inline" method="post" action="/dashboard/profiles/assign">${hidden}<input type="hidden" name="key" value="${esc(k.name)}"><select name="profile"><option value="">(unrestricted)</option>${profileOptions}</select><button>set profile</button></form>
          <form class="inline" method="post" action="/dashboard/keys/revoke">${hidden}<input type="hidden" name="name" value="${esc(k.name)}"><button class="danger">revoke</button></form>
        </td></tr>`;
    })
    .join("");

  const profileRows = profiles
    .map(
      (p) => `<tr><td>${esc(p.name)}</td>
      <td>${p.rules.map((r) => `<code>${esc(r.upstreamName)} ${esc(r.toolPattern)}</code> <form class="inline" method="post" action="/dashboard/profiles/disallow">${hidden}<input type="hidden" name="profile" value="${esc(p.name)}"><input type="hidden" name="upstream" value="${esc(r.upstreamName)}"><input type="hidden" name="pattern" value="${esc(r.toolPattern)}"><button class="danger">x</button></form>`).join("<br>") || "(allows nothing)"}</td>
      <td>
        <form class="inline" method="post" action="/dashboard/profiles/allow">${hidden}<input type="hidden" name="profile" value="${esc(p.name)}"><input name="upstream" placeholder="upstream or *" size="10"><input name="pattern" placeholder="tool pattern or *" size="12"><button>allow</button></form>
        <form class="inline" method="post" action="/dashboard/profiles/delete">${hidden}<input type="hidden" name="name" value="${esc(p.name)}"><button class="danger">delete</button></form>
      </td></tr>`,
    )
    .join("");

  const auditRows = listAudit(db, { limit: 30 })
    .map(
      (r) =>
        `<tr><td>${esc(r.ts)}</td><td>${esc(r.keyName)}</td><td><code>${esc(r.tool)}</code></td><td>${esc(r.upstream ?? "builtin")}${r.account ? ` (${esc(r.account)})` : ""}</td><td class="${r.outcome === "ok" ? "ok" : "bad"}">${esc(r.outcome)}</td><td>${r.durationMs}ms</td><td>${esc(r.detail ?? "")}</td></tr>`,
    )
    .join("");

  return `
  <form class="inline" method="post" action="/dashboard/logout" style="float:right">${hidden}<button>Log out</button></form>
  <h1>${esc(SERVER_NAME)} <small>v${esc(SERVER_VERSION)}</small></h1>
  ${msg}${err}

  <h2>Upstream servers</h2>
  <table><tr><th>Server</th><th>Auth</th><th>State</th><th>Linked accounts</th><th></th></tr>${upstreamRows || "<tr><td colspan=5>none</td></tr>"}</table>
  <p><form method="post" action="/dashboard/upstreams/add">${hidden}
    <input name="name" placeholder="name" size="10" required>
    <input name="url" placeholder="https://vendor.example/mcp" size="34" required>
    <select name="authMode"><option value="oauth">oauth</option><option value="none">none</option><option value="bearer">bearer</option></select>
    <input name="bearer" placeholder="bearer token (if bearer)" size="18">
    <button>add upstream</button>
  </form></p>

  <h2>Client connections</h2>
  <table><tr><th>Name</th><th>Created</th><th>Profile</th><th></th></tr>${keyRows || "<tr><td colspan=4>none</td></tr>"}</table>
  <p><form method="post" action="/dashboard/keys/create">${hidden}<input name="name" placeholder="key name" required><button>create API key</button></form>
  (web clients appear here automatically after they authorize via OAuth)</p>

  <h2>Profiles</h2>
  <table><tr><th>Name</th><th>Rules</th><th></th></tr>${profileRows || "<tr><td colspan=3>none — all connections unrestricted</td></tr>"}</table>
  <p><form method="post" action="/dashboard/profiles/create">${hidden}<input name="name" placeholder="profile name" required><button>create profile</button></form></p>

  <h2>Recent tool calls</h2>
  <table><tr><th>When</th><th>Connection</th><th>Tool</th><th>Target</th><th>Outcome</th><th>Time</th><th>Detail</th></tr>${auditRows || "<tr><td colspan=7>none yet</td></tr>"}</table>`;
}

function getConnectionProfileName(db: Db, keyId: number): string | null {
  const row = db
    .prepare("SELECT p.name FROM api_keys k JOIN profiles p ON p.id = k.profile_id WHERE k.id = ?")
    .get(keyId) as { name: string } | undefined;
  return row?.name ?? null;
}
