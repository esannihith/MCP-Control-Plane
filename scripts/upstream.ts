import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { UpstreamManager } from "../src/upstream/manager.js";
import { addUpstream, listUpstreams, removeUpstream } from "../src/upstream/registry.js";
import { Vault } from "../src/vault/index.js";

const args = process.argv.slice(2);
const command = args[0];
const config = loadConfig();
const db = openDb(config.dbPath);
const vault = config.masterKey ? new Vault(config.masterKey) : null;

switch (command) {
  case "add": {
    const [, name, url] = args;
    if (!name || !url) usage("add requires <name> <url>");
    const bearerIndex = args.indexOf("--bearer");
    let bearer = bearerIndex >= 0 ? args[bearerIndex + 1] : undefined;
    const oauth = args.includes("--oauth");
    if (bearer && !vault) usage("--bearer requires CP_MASTER_KEY (generate: npm run key -- master)");
    if (bearer && vault) bearer = vault.encrypt(bearer);
    addUpstream(db, name, url, { bearerToken: bearer, oauth });
    if (oauth) {
      console.log(`Upstream '${name}' registered (${url}, OAuth).`);
      console.log(`Link an account next: npm run account -- link ${name} --label <who>`);
      break;
    }
    console.log(`Upstream '${name}' registered (${url}). Connecting to ingest tools...`);
    const manager = new UpstreamManager(db, vault);
    await manager.start();
    const status = manager.status().find((s) => s.name === name);
    if (status?.connected) {
      console.log(`Connected. Ingested ${status.toolCount} tools.`);
    } else {
      console.log("Could not connect now; tools will be ingested when the server reaches it.");
    }
    await manager.stop();
    console.log("Restart the control plane server to serve this upstream.");
    break;
  }
  case "list": {
    const upstreams = listUpstreams(db);
    if (upstreams.length === 0) {
      console.log("No upstreams registered.");
      break;
    }
    for (const u of upstreams) {
      const tools = (db.prepare("SELECT COUNT(*) AS n FROM upstream_tools WHERE upstream_id = ?").get(u.id) as { n: number }).n;
      console.log(`${u.id}\t${u.name}\t${u.url}\t${u.enabled ? "enabled" : "disabled"}\t${u.auth_mode}\t${tools} tools`);
    }
    break;
  }
  case "remove": {
    const [, name] = args;
    if (!name) usage("remove requires <name>");
    console.log(removeUpstream(db, name) ? `Upstream '${name}' removed.` : `No upstream named '${name}'.`);
    break;
  }
  default:
    usage();
}
db.close();

function usage(error?: string): never {
  if (error) console.error(`Error: ${error}\n`);
  console.log("Usage: npm run upstream -- <add|list|remove> [name] [url] [--bearer <token>] [--oauth]");
  process.exit(error ? 1 : 0);
}
