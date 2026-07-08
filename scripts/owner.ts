import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { hasOwnerPassword, setOwnerPassword, verifyOwnerPassword } from "../src/authserver/owner.js";

const [command, value] = process.argv.slice(2);
const db = openDb(loadConfig().dbPath);

switch (command) {
  case "set-password": {
    const password = value ?? randomBytes(12).toString("base64url");
    const replacing = hasOwnerPassword(db);
    setOwnerPassword(db, password);
    if (!value) console.log(`Generated owner password (shown ONCE — store it now):\n\n  ${password}\n`);
    console.log(replacing ? "Owner password replaced." : "Owner password set.");
    console.log("It is required on the OAuth consent screen when clients like claude.ai connect.");
    break;
  }
  case "check-password": {
    if (!value) usage("check-password requires the password to test");
    console.log(verifyOwnerPassword(db, value) ? "Password is correct." : "Password is WRONG.");
    break;
  }
  default:
    usage();
}
db.close();

function usage(error?: string): never {
  if (error) console.error(`Error: ${error}\n`);
  console.log("Usage: npm run owner -- <set-password|check-password> [password]");
  process.exit(error ? 1 : 0);
}
