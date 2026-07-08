# Walkthrough

A runnable log of how to exercise each completed part. Updated at every checkpoint. Everything assumes a terminal at the repo root; the dev database lives in `data/` (gitignored — safe to delete for a fresh start).

## Setup (once)

```bash
npm install
npm run key -- master        # prints a CP_MASTER_KEY line — put it in .env
copy .env.example .env       # then paste the CP_MASTER_KEY line in
npm test                     # everything should be green
```

## Part 1 — Gateway spine (API-key auth)

```bash
npm run key -- create my-laptop     # key shown ONCE — copy it
npm run key -- list
npm run dev                          # MCP endpoint: http://127.0.0.1:8720/mcp
```

Connect a header-capable client, e.g. Claude Code:

```bash
claude mcp add --transport http control-plane http://127.0.0.1:8720/mcp \
  --header "Authorization: Bearer cpk_..."
```

Ask the model to call `control_plane_status` — it reports the connection's key name and session. Requests without a key get 401; a second key's requests can't reuse another key's session (403).

Revoke access at any time: `npm run key -- revoke my-laptop`.

## Part 2 — Upstream proxying

```bash
npm run upstream -- add someserver https://example.com/mcp            # no auth
npm run upstream -- add secured https://example.com/mcp --bearer TOKEN # static bearer
npm run upstream -- list
npm run dev                          # restart to serve newly added upstreams
```

The client now sees that server's tools namespaced as `someserver_<tool>`. `control_plane_status` shows per-upstream connection state and tool counts. If an upstream is down, its tools return a readable "unavailable" error and recover automatically once it's back.

Remove with `npm run upstream -- remove someserver` (CLI stands in for the dashboard until Part 7).

## Part 3 — OAuth upstreams + linked accounts

Requires `CP_MASTER_KEY` in `.env` (see Setup). Tokens are stored AES-256-GCM encrypted; losing the master key means re-linking everything.

```bash
npm run upstream -- add notion https://mcp.notion.com/mcp --oauth
npm run account -- link notion --label you@example.com
# → prints an authorization URL (and opens your browser); approve at the vendor
npm run account -- list
npm run dev
```

Works with any OAuth-protected remote MCP (Notion, GitHub `https://api.githubcopilot.com/mcp/`, Linear, …). Token refresh is automatic and silent.

**Linking a second account at the same vendor** — the consent screen shows whoever your *browser* is logged in as; the `--label` is only the control plane's bookkeeping name and is never verified against the vendor:

```bash
npm run account -- link notion --label other@example.com --no-open
# copy the printed URL into an INCOGNITO/private window, log in as the other
# account there, approve
```

Unlink with `npm run account -- unlink notion you@example.com`.

## Part 4 — Account bindings + switching

With two accounts linked at one upstream, each **client connection** (API key) gets its own binding:

- One linked account → auto-bound silently on first use, nothing to do.
- Several linked accounts → the first tool call returns a structured
  `action_required: select_account` result listing the options; the model asks
  you in chat and calls `switch_account` with your choice.

From any connected client's chat:

> *"Which accounts do I have on notion?"* → model calls `list_accounts`
> *"Use the other account"* → model calls `switch_account { upstream: "notion", account: "other@example.com" }`

Switching affects **only that client** — ChatGPT on Jane's account never moves Gemini off John's. Bindings persist across sessions/restarts (they're keyed to the API key, not the session). `control_plane_status` shows this connection's current binding per upstream.

Two-client demo: create two API keys (`npm run key -- create client-a`, `... client-b`), connect two different MCP clients with them, bind each to a different account, and call an identity-revealing tool from both.

**Troubleshooting — "Invalid MCP state. Please enable browser cookies and try again." on the vendor's authorize page** (seen with Chrome; Brave worked): this error comes from the *vendor's* OAuth page, not the control plane — our link flow uses no cookies at all (state travels in the URL). Vendors like Notion set a browser cookie to pin their own OAuth state; a profile with stale vendor cookies, strict tracking protection, or an interfering extension breaks *their* check. Fix: clear cookies for the vendor's domain (or use an incognito window / another profile) and re-run the link command. Verified working via a real client (Antigravity) on 2026-07-09.

## Part 5 — OAuth for web clients (claude.ai / ChatGPT)

The control plane is now its own OAuth 2.1 authorization server, which is the only way claude.ai and ChatGPT connectors can authenticate (they cannot send API-key headers). One-time setup:

```bash
npm run owner -- set-password          # generates + prints the owner password (or pass your own)
```

**Local sanity check** (works without a tunnel): point MCP Inspector or any OAuth-capable client at `http://127.0.0.1:8720/mcp` with no credentials. You'll get the discovery → registration → consent flow; enter the owner password on the consent page and approve. `control_plane_status` then shows your connection as `oauth:<client-name>:<id>`.

**Web clients need a public HTTPS URL** (manual step):

```bash
# e.g. Cloudflare Tunnel (or any reverse proxy with TLS)
cloudflared tunnel --url http://127.0.0.1:8720
```

Set `CP_PUBLIC_URL=https://<your-tunnel-host>` in `.env` and restart — the OAuth metadata advertises this URL, so it must match what clients see. Then:

- **claude.ai**: Settings → Connectors → Add custom connector → paste `https://<host>/mcp`. Claude discovers the auth server, registers itself, and sends you to the consent page.
- **ChatGPT**: Settings → Apps & Connectors (developer mode) → create a connector with the same URL and OAuth.

Each approved client becomes its own connection (visible in `npm run key -- list` as `oauth:...`) with its own account bindings — revoke it there to cut access. Quick-tunnel caveat: a fresh `cloudflared --url` hostname changes on every run, which changes `CP_PUBLIC_URL` and invalidates prior client registrations; use a named tunnel or stable domain for anything beyond a demo.
