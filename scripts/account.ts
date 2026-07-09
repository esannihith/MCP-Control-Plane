import { exec } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { Vault } from "../src/vault/index.js";
import { linkAccount } from "../src/accounts/link.js";
import { deleteAccount, listAccounts } from "../src/accounts/index.js";
import { listUpstreams } from "../src/upstream/registry.js";

const args = process.argv.slice(2);
const command = args[0];
const config = loadConfig();
const db = openDb(config.dbPath);

switch (command) {
  case "link": {
    const upstreamName = args[1];
    if (!upstreamName) usage("link requires <upstream>");
    if (!config.masterKey) usage("CP_MASTER_KEY is not set. Generate one with: npm run key -- master");
    const upstream = listUpstreams(db).find((u) => u.name === upstreamName);
    if (!upstream) usage(`No upstream named '${upstreamName}'. Register it first: npm run upstream -- add`);
    if (upstream.auth_mode !== "oauth") {
      usage(`Upstream '${upstreamName}' is '${upstream.auth_mode}', not oauth. Re-add it with --oauth to link accounts.`);
    }
    const labelIndex = args.indexOf("--label");
    const label = labelIndex >= 0 ? args[labelIndex + 1] : "default";
    const noOpen = args.includes("--no-open");
    const relink = args.includes("--relink");
    const vault = new Vault(config.masterKey);
    const existing = listAccounts(db, upstream.id).filter((a) => a.linked);
    if (existing.some((a) => a.label === label) && !relink) {
      usage(
        `Account '${label}' is ALREADY linked at '${upstreamName}' — no new authorization was started.\n` +
          `  To link a DIFFERENT account:   npm run account -- link ${upstreamName} --label <new-label>\n` +
          `  To re-authorize '${label}':    npm run account -- link ${upstreamName} --label ${label} --relink`,
      );
    }
    console.log(`Linking account '${label}' at upstream '${upstreamName}'...`);
    if (existing.length > 0) {
      console.log(
        `NOTE: ${existing.length} account(s) already linked here. The vendor's consent screen uses your BROWSER session,\n` +
          "not the label — open the URL below in an incognito/private window to authorize a different account.",
      );
    }
    const account = await linkAccount(db, vault, upstream, {
      label,
      forceReauth: relink,
      openUrl: (url) => {
        console.log(`\nOpen this URL in your browser to authorize:\n\n  ${url}\n`);
        if (!noOpen) exec(`start "" "${url}"`); // best-effort browser launch on Windows
      },
    });
    console.log(`Linked '${account.label}' (account #${account.id}). Tokens stored encrypted.`);
    console.log("Ingesting tools...");
    const { UpstreamManager } = await import("../src/upstream/manager.js");
    const manager = new UpstreamManager(db, vault);
    await manager.start();
    const status = manager.status().find((s) => s.name === upstreamName);
    console.log(status?.connected ? `Connected. ${status.toolCount} tools available.` : "Could not connect yet.");
    await manager.stop();
    break;
  }
  case "list": {
    const accounts = listAccounts(db);
    if (accounts.length === 0) {
      console.log("No linked accounts.");
      break;
    }
    const upstreams = new Map(listUpstreams(db).map((u) => [u.id, u.name]));
    for (const a of accounts) {
      console.log(
        `${a.id}\t${upstreams.get(a.upstreamId) ?? a.upstreamId}\t${a.label}\t${a.linked ? "linked" : "PENDING"}\tsince ${a.createdAt}`,
      );
    }
    break;
  }
  case "unlink": {
    const [, upstreamName, label] = args;
    if (!upstreamName || !label) usage("unlink requires <upstream> <label>");
    const upstream = listUpstreams(db).find((u) => u.name === upstreamName);
    if (!upstream) usage(`No upstream named '${upstreamName}'`);
    console.log(
      deleteAccount(db, upstream.id, label)
        ? `Account '${label}' unlinked from '${upstreamName}'.`
        : `No account '${label}' at '${upstreamName}'.`,
    );
    break;
  }
  default:
    usage();
}
db.close();

function usage(error?: string): never {
  if (error) console.error(`Error: ${error}\n`);
  console.log("Usage: npm run account -- <link|list|unlink> [upstream] [label] [--label <label>] [--no-open] [--relink]");
  process.exit(error ? 1 : 0);
}
