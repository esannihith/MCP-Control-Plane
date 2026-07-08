# Phase 1 — Implementation Plan

Phase 1 from [README.md](README.md#mvp-scope--roadmap), broken into 7 reviewable parts. Each part runs the same loop: **plan → code → test → iterate**, ending at a **checkpoint** where the code is reviewed before the next part starts. Manual steps I can't do (installing system packages, creating OAuth apps at vendors, connecting real clients) are flagged per part as **Manual**.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 + TypeScript | Official MCP TypeScript SDK is the most complete (server + client + streamable HTTP + auth helpers) |
| MCP | `@modelcontextprotocol/sdk` | Used in both roles: server toward clients, client toward upstreams |
| HTTP | Express 5 | What the SDK's transports and auth router integrate with out of the box |
| Database | SQLite via `better-sqlite3` | Zero-config, single file, right for self-hosted single-user MVP |
| Validation | Zod v3 | SDK peer dependency; used for config, tool schemas, API bodies |
| Crypto | Node `crypto` (AES-256-GCM) | Vault encryption with a master key from env; no extra deps |
| Tests | Vitest | Fast TS-native runner; integration tests use the real SDK client against a live server instance |
| Dashboard | Server-rendered EJS + vanilla JS | No frontend build step at MVP; it's an admin panel, not a product UI |
| Packaging | Dockerfile + docker-compose | The self-hosted deploy story |

Repo layout (grows part by part):

```
src/
  config.ts            # env-driven config
  db/                  # sqlite bootstrap + migrations
  gateway/             # MCP server toward clients (transport, sessions, auth)
  upstream/            # MCP client toward upstreams (registry, connections, namespacing)
  vault/               # encrypted token store
  accounts/            # linked accounts + per-connection bindings
  authserver/          # OAuth 2.1 AS toward clients (DCR, PKCE, consent)
  audit/               # audit logging
  dashboard/           # admin UI + JSON API
test/                  # vitest suites incl. mock upstream MCP server
```

---

## Part 1 — Scaffold + gateway spine (API-key auth)

The smallest thing a real MCP client can connect to.

- Project scaffold: TypeScript, Vitest, npm scripts, `.env` config loading
- SQLite bootstrap with a simple migration runner; tables: `api_keys`, `settings`
- Streamable HTTP MCP endpoint at `POST/GET/DELETE /mcp` with per-session transports
- Auth middleware: `Authorization: Bearer cpk_...` API keys (stored hashed); 401 with proper `WWW-Authenticate` otherwise
- CLI script `npm run key -- create <name>` (dashboard doesn't exist yet)
- One built-in tool (`control_plane_status`) proving end-to-end tool calls
- **Tests:** integration — spin up server, connect with the SDK client, initialize, list tools, call tool; reject missing/bad key
- **Checkpoint 1:** review scaffold + connect Claude Code or Cursor to `http://localhost:<port>/mcp` with a generated key

## Part 2 — Upstream proxy core + catalog

The control plane becomes a real proxy.

- `upstreams` table + registration via CLI (dashboard later); connect to upstream MCP servers as an SDK client (streamable HTTP; no auth or static bearer for now)
- Tool ingestion: fetch upstream tool lists, store in registry, expose namespaced (`<server>_<tool>`, 64-char safe, deterministic dedupe)
- Proxy `tools/call`: resolve namespaced name → upstream session → forward → return result; upstream reconnect on drop
- Mock upstream MCP server in `test/` (echo + failing tools) used by all future suites
- **Tests:** namespacing edge cases (collisions, length), proxy round-trip, upstream-down behavior
- **Checkpoint 2:** two mock upstreams proxied through one endpoint in a real client

## Part 3 — Vault + upstream OAuth (linked accounts)

The auth centerpiece, upstream side.

- Vault: AES-256-GCM encryption, master key from env (`CP_MASTER_KEY`), key-rotation-friendly format
- OAuth client toward upstreams: discovery (RFC 9728 → AS metadata), dynamic client registration where offered, authorization-code + PKCE, token storage + refresh; browser flow completed via a local callback route
- `linked_accounts` table: multiple accounts per upstream
- CLI: `npm run account -- link <upstream>` prints the auth URL, waits for callback
- **Tests:** vault round-trip + tamper detection; OAuth flow against a mock OAuth-protected upstream (mock AS included); refresh-on-expiry
- **Manual:** picking 1–2 real OAuth-protected remote MCPs to verify against (e.g. Notion/GitHub official MCP); any vendor app registration if required
- **Checkpoint 3:** link a real vendor account once, call its tools through the proxy

## Part 4 — Account bindings + switching

The differentiator.

- `bindings` table: (client connection × upstream) → linked account
- Tool call with no binding returns the structured **account-required** result (options list, per README flow)
- Built-in tools: `list_accounts`, `switch_account` — switching affects only the calling connection
- Multiple client connections with different bindings against the same upstream, concurrently
- **Tests:** binding resolution, account-required flow, switch isolation between two live client sessions
- **Checkpoint 4:** demo — two clients, same upstream, different accounts; mid-session switch via chat

## Part 5 — OAuth 2.1 authorization server (web-client auth)

The gate to claude.ai and ChatGPT.

- AS endpoints: `/.well-known/oauth-protected-resource`, AS metadata, `POST /oauth/register` (DCR, RFC 7591), `GET/POST /oauth/authorize` (PKCE required), `POST /oauth/token` (+ refresh)
- Minimal login + consent pages (the control plane owner is the only user; password from initial setup)
- Access tokens audience-bound to the control plane; OAuth-authenticated connections join API-key connections as first-class client connections
- **Tests:** full authorization-code + PKCE dance with the SDK client's auth support; rejection paths (bad PKCE, wrong audience, expired)
- **Manual:** a public HTTPS URL (Cloudflare Tunnel or similar) so claude.ai/ChatGPT can reach it — needed for the checkpoint demo
- **Checkpoint 5:** claude.ai (or ChatGPT dev mode) completes OAuth and calls a proxied tool

## Part 6 — Profiles + audit log

Control and visibility.

- `profiles` table: named server/tool allowlists; each connection gets a profile; tool list rendered per profile
- Audit log: one row per tool call (connection, upstream, account, tool, latency, outcome) — **metadata only, no payloads**
- Built-in `control_plane_status` grows: current profile, bindings, upstream health
- **Tests:** profile filtering of tools/list and tools/call, audit rows written on success/failure
- **Checkpoint 6:** two connections with different profiles see different catalogs; audit trail reviewed

## Part 7 — Dashboard + packaging

Ship it.

- Dashboard (session-auth, password + CSRF): upstream servers CRUD, linked accounts (link/unlink), API keys (create/revoke), OAuth grants (revoke), bindings, profiles, audit log view
- Destructive ops (remove server, unlink account, revoke) exist **only** here — enforced at the service layer, not just the UI
- Dockerfile + docker-compose.yml + `.env.example`; short deploy guide incl. tunnel setup
- **Tests:** dashboard API authz (no session → 401), destructive ops unreachable via MCP surface
- **Manual:** Docker Desktop if a container build/run check is wanted; domain/tunnel for real deploy
- **Checkpoint 7 (Phase 1 exit):** conformance pass against Claude Code, Cursor, and claude.ai/ChatGPT per README's Phase 1 test list

---

## Working agreement

- One part at a time; each ends with all tests green and a checkpoint note summarizing what to review and how to run it.
- Feedback at a checkpoint is folded in before the next part begins.
- Scope discipline: rate limiting, elicitation, `tools/list_changed`, meta-tool mode, stdio shim are **Phase 2** — not built here even where tempting.
