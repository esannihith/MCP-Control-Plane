import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  addRule,
  assignProfile,
  createProfile,
  deleteProfile,
  getProfileByName,
  listProfiles,
  removeRule,
} from "../src/profiles.js";

const args = process.argv.slice(2);
const command = args[0];
const db = openDb(loadConfig().dbPath);

function requireProfile(name?: string) {
  if (!name) usage("profile name required");
  const profile = getProfileByName(db, name);
  if (!profile) usage(`No profile named '${name}'`);
  return profile;
}

switch (command) {
  case "create": {
    if (!args[1]) usage("create requires <name>");
    createProfile(db, args[1]);
    console.log(`Profile '${args[1]}' created (empty = allows nothing). Add rules: npm run profile -- allow ${args[1]} <upstream> [toolPattern]`);
    break;
  }
  case "delete": {
    if (!args[1]) usage("delete requires <name>");
    console.log(deleteProfile(db, args[1]) ? `Profile '${args[1]}' deleted; connections using it are unrestricted again.` : `No profile named '${args[1]}'.`);
    break;
  }
  case "list": {
    const profiles = listProfiles(db);
    if (profiles.length === 0) {
      console.log("No profiles. Connections without a profile see the full catalog.");
      break;
    }
    for (const p of profiles) {
      console.log(`${p.name}:`);
      for (const r of p.rules) console.log(`  allow ${r.upstreamName} ${r.toolPattern}`);
      if (p.rules.length === 0) console.log("  (no rules — allows nothing)");
    }
    break;
  }
  case "allow": {
    const profile = requireProfile(args[1]);
    if (!args[2]) usage("allow requires <profile> <upstream> [toolPattern]");
    addRule(db, profile.id, args[2], args[3] ?? "*");
    console.log(`Rule added: '${profile.name}' allows ${args[2]} ${args[3] ?? "*"}`);
    break;
  }
  case "disallow": {
    const profile = requireProfile(args[1]);
    if (!args[2]) usage("disallow requires <profile> <upstream> [toolPattern]");
    console.log(removeRule(db, profile.id, args[2], args[3] ?? "*") ? "Rule removed." : "No such rule.");
    break;
  }
  case "assign": {
    const [, keyName, profileName] = args;
    if (!keyName || !profileName) usage("assign requires <keyName> <profile>");
    const profile = requireProfile(profileName);
    console.log(
      assignProfile(db, keyName, profile.id)
        ? `Connection '${keyName}' now uses profile '${profileName}'.`
        : `No connection named '${keyName}' (npm run key -- list).`,
    );
    break;
  }
  case "unassign": {
    if (!args[1]) usage("unassign requires <keyName>");
    console.log(assignProfile(db, args[1], null) ? `Connection '${args[1]}' is unrestricted.` : `No connection named '${args[1]}'.`);
    break;
  }
  default:
    usage();
}
db.close();

function usage(error?: string): never {
  if (error) console.error(`Error: ${error}\n`);
  console.log("Usage: npm run profile -- <create|delete|list|allow|disallow|assign|unassign> ...");
  console.log("  allow <profile> <upstream|*> [toolPattern|*]   e.g. allow phone notion 'notion_search*'");
  process.exit(error ? 1 : 0);
}
