# CLI-only guide

Everything the control plane does, operable from a terminal — no dashboard needed. All commands run from the repo root and operate on the database at `CP_DB_PATH` (default `./data/control-plane.db`). In the Docker image the same CLIs exist as `node dist/scripts/<name>.js ...`.

One caveat: **CLI account linking requires the browser and the CLI on the same machine** (the OAuth callback is a loopback listener). For a remote deployment, link accounts in the dashboard instead.

## Setup

```bash
npm install
npm run key -- master                    # prints CP_MASTER_KEY → put in .env
npm run owner -- set-password            # dashboard/consent password (prints one if omitted)
npm run dev                              # serves http://127.0.0.1:8720/mcp
```

## API keys (header-capable clients)

```bash
npm run key -- create my-laptop          # plaintext shown once
npm run key -- list                      # includes web clients' oauth:* connections
npm run key -- revoke my-laptop          # also kills an oauth connection's tokens
```

Client config: `Authorization: Bearer cpk_...` against `http://host:8720/mcp`, e.g.

```bash
claude mcp add --transport http control-plane http://127.0.0.1:8720/mcp \
  --header "Authorization: Bearer cpk_..."
```

## Upstream vendors

```bash
npm run upstream -- add notion https://mcp.notion.com/mcp --oauth
npm run upstream -- add internal https://tools.corp/mcp --bearer TOKEN   # static token (vault-encrypted)
npm run upstream -- add public https://example.com/mcp                   # no auth
npm run upstream -- list
npm run upstream -- remove public
```

OAuth upstreams expose no tools until an account is linked.

## Accounts (OAuth upstreams)

```bash
npm run account -- link notion --label john@example.com          # opens browser
npm run account -- link notion --label jane@example.com --no-open  # print URL only → open in INCOGNITO
npm run account -- link notion --label john@example.com --relink   # force re-authorization
npm run account -- list
npm run account -- unlink notion jane@example.com
```

Omitting `--label` targets `default`. Linking an already-linked label is refused (use a new label or `--relink`). The consent screen authorizes whoever the *browser* is logged in as — the label is not verified against the vendor.

Per-client account selection happens in chat, not the CLI: models call `list_accounts` / `switch_account`; a switch affects only the calling client.

## Profiles (per-client tool allowlists)

```bash
npm run profile -- create phone                       # allows NOTHING until rules added
npm run profile -- allow phone notion                 # all notion tools
npm run profile -- allow phone linear "linear_list*"  # prefix pattern
npm run profile -- assign my-laptop phone             # key name from: npm run key -- list
npm run profile -- unassign my-laptop                 # back to unrestricted
npm run profile -- list
npm run profile -- disallow phone notion
npm run profile -- delete phone
```

Connections without a profile see the full catalog.

## Audit

```bash
npm run audit -- tail 50    # newest last: connection, tool, target, outcome, latency
```

Metadata only — arguments and results are never stored.

## Owner password

```bash
npm run owner -- set-password [password]   # generates one if omitted
npm run owner -- check-password <password>
```

Needed for the dashboard and whenever a web client (claude.ai/ChatGPT) authorizes via OAuth. `CP_OWNER_PASSWORD` in the environment seeds it on first boot of a fresh database.
