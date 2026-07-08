import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../src/keys.js";

const [command, name] = process.argv.slice(2);
const db = openDb(loadConfig().dbPath);

switch (command) {
  case "create": {
    if (!name) usage("create requires a key name");
    const { key } = createApiKey(db, name);
    console.log(`API key '${name}' created. Shown ONCE — store it now:\n\n  ${key}\n`);
    console.log(`Client config: Authorization: Bearer ${key}`);
    break;
  }
  case "list": {
    const keys = listApiKeys(db);
    if (keys.length === 0) {
      console.log("No API keys.");
      break;
    }
    for (const k of keys) {
      console.log(`${k.id}\t${k.name}\tcreated ${k.createdAt}${k.revokedAt ? `\tREVOKED ${k.revokedAt}` : ""}`);
    }
    break;
  }
  case "revoke": {
    if (!name) usage("revoke requires a key name");
    console.log(revokeApiKey(db, name) ? `Key '${name}' revoked.` : `No active key named '${name}'.`);
    break;
  }
  default:
    usage();
}
db.close();

function usage(error?: string): never {
  if (error) console.error(`Error: ${error}\n`);
  console.log("Usage: npm run key -- <create|list|revoke> [name]");
  process.exit(error ? 1 : 0);
}
