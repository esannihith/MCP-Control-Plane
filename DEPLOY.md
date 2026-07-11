# Deploying the MCP Control Plane

The dashboard covers everything a remote deploy needs (upstreams, account linking, keys, profiles, audit) — no shell required after setup.

## Railway

1. Push this repo to GitHub and create a Railway project from it. [railway.json](railway.json) pins the Dockerfile builder, the `/healthz` healthcheck, and the restart policy.
2. **Add a volume** mounted at `/data` (Service → Settings → Volumes). Without it the SQLite database — including your encrypted tokens — is wiped on every deploy.
3. **Generate a domain** (Settings → Networking → Generate Domain), then set the service variables:

   | Variable | Value |
   |---|---|
   | `CP_PUBLIC_URL` | `https://<your-domain>` — exactly, no trailing slash |
   | `CP_MASTER_KEY` | generate locally: `npm run key -- master` |
   | `GOOGLE_CLIENT_ID` | Google OAuth client (console.cloud.google.com → Credentials → OAuth client, Web application) |
   | `GOOGLE_CLIENT_SECRET` | from the same OAuth client |

   The Google client's authorized redirect URI must be `https://<your-domain>/auth/google/callback`. `PORT` is injected by Railway automatically; the Dockerfile already sets `CP_HOST=0.0.0.0` and `CP_DB_PATH=/data/control-plane.db`. All four variables are required — production boots refuse to start without them.
4. Deploy. Then open `https://<domain>/dashboard`:
   - add upstream vendors (auth mode `oauth` for Notion/Linear/GitHub-style remote MCPs),
   - **link accounts in the browser** — the flow redirects through the vendor and back to `/upstream-callback` (to link a second vendor account, log out at the vendor first or complete the flow in an incognito window),
   - create API keys for header-capable clients (Claude Code, Cursor, VS Code, Gemini CLI, Antigravity).
5. Connect clients to `https://<domain>/mcp` — web clients (claude.ai, ChatGPT) via OAuth (they discover the auth server automatically), header clients with `Authorization: Bearer cpk_...`.

Notes:
- Changing the domain later invalidates web clients' OAuth registrations and vendor callback URLs (`CP_PUBLIC_URL` is baked into both) — clients must re-authorize and accounts may need re-linking.
- Losing `CP_MASTER_KEY` makes every stored token unrecoverable; back it up.
- Container CLI, if ever needed: `railway ssh` → `node dist/scripts/key.js list` (all CLIs are compiled into the image; see [CLI.md](CLI.md)).

## Docker / self-hosted box

```bash
cp .env.example .env    # fill in CP_MASTER_KEY, CP_OWNER_PASSWORD, CP_PUBLIC_URL
docker compose up -d    # data persists in ./data
```

Put TLS in front (Caddy/nginx/Cloudflare Tunnel) and set `CP_PUBLIC_URL` to the public HTTPS URL. `trust proxy` is already configured for a single proxy hop.
