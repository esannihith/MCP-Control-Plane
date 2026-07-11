# Phase 2 — SaaS Control Plane (production-grade, deploy-per-part)

Turns the field-proven single-tenant control plane into a multi-tenant SaaS with a polished dashboard. Former Phase 2 items (elicitation, stdio shim, tool pinning, granular rate limiting) moved to Phase 3.

**Working style:** DevOps loop per part — plan → code → test → deploy → user field-tests → iterate. UI skeleton first, then wire one functionality at a time. New ideas are triaged into parts or parked in PHASE3.md (parked so far: restrict-vendor-per-client).

**Locked decisions**

1. **Meta-tools only** as the default tool surface (~6 tools regardless of vendor count); full passthrough stays as a per-connection override.
2. **Multi-account = account param + fan-out** on `invoke_tool`; one upstream per vendor.
3. **Multi-tenant SaaS with Google sign-in only** — no password storage/reset surface in a credential-custody product. Manual: user creates the Google OAuth client (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`).
4. **Connector store: curated catalog with rich descriptions** (provider, tools, permissions) + **tool permission model**: read tools allowed by default, mutation tools need explicit grant.
5. **UI: React + Vite + Tailwind SPA** under `/app`, over a zod-validated JSON API under `/api`.

**Production bar (every part):** zod at every API boundary; hardened DB-backed sessions (HttpOnly/Lax/Secure, hashed at rest, rotation on login); rate limits on auth + link endpoints; security headers; additive-only boot migrations (deploy-safe with the Railway volume); indexes on hot paths; latency-tagged request logs; payloads never in logs/audit.

**Architecture shifts:** `web/` frontend workspace served statically with SPA fallback; Google OIDC verified via JWKS (`jose`); `user_id` tenancy on upstreams/api_keys/profiles/audit (accounts/bindings/tokens inherit via FKs); per-user MCP endpoint `/u/<slug>/mcp` with path-suffixed RFC 9728 metadata; legacy `/mcp` aliases the owner tenant; first Google login matching `CP_OWNER_EMAIL` claims pre-tenancy data; Docker/CI gain a frontend build stage.

## Parts

Each part ends: tests green → CI → deploy → user preview/checkpoint.

1. **Foundation** — users + Google OIDC login, DB-backed sessions, tenancy migration + legacy claim, auth rate limiting, security headers, `web/` scaffold with real login page, Docker/CI updates.
2. **UI skeleton** — full app shell + all pages with mock data, empty states, toasts, confirm dialogs. No wiring; deployed for layout feedback.
3. **Store & upstreams wired** — curated `catalog/connectors.json`, `/api/catalog` + `/api/upstreams`, Store + My Connectors pages, read/write tool classification (`is_write`).
4. **Account linking wired + identity** — per-user link flows, Accounts page, OIDC id_token claims + catalog identity probes, verified/unverified badges.
5. **Client connections wired** — `/u/<slug>/mcp` per-user endpoints + metadata, user-aware consent with a connection-name field, API keys UI, last-used, stale prune.
6. **Tool surface** — `list_tools`/`describe_tool`/`invoke_tool`, per-connection `tool_mode` (meta default for new), `account`/`accounts` fan-out with per-account envelopes and audit rows.
7. **Permissions wired** — per-connection policy (`full`/`read_only`/`reads_plus_granted`, new default `reads_plus_granted`), per-tool write grants compiled onto the profiles engine, Permissions editor page replacing raw profile forms.
8. **Audit UI, observability, hardening, docs** — audit filters/pagination, request logging + index pass, link/auth rate limits, timeboxed Notion invalid-state investigation, market re-scan + positioning, README/DEPLOY/CLI/WALKTHROUGH refresh, PHASE3.md.

## Phase exit (E2E on the deployment)

Two Google accounts get isolated workspaces; Notion added from the store, two accounts linked with real identities shown; claude.ai connected to `/u/<slug>/mcp` with a named connection sees ~6 meta-tools; one batch write lands in both Notion accounts; a mutation tool is blocked until granted in Permissions; audit filters show all of it.
