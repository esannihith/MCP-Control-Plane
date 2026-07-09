import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { listAudit } from "../src/audit.js";

const [command, arg] = process.argv.slice(2);
const db = openDb(loadConfig().dbPath);

if (command !== "tail" && command !== undefined) {
  console.log("Usage: npm run audit -- tail [n]");
  process.exit(1);
}

const rows = listAudit(db, { limit: arg ? Number(arg) : 25 });
if (rows.length === 0) {
  console.log("Audit log is empty.");
} else {
  for (const row of rows.reverse()) {
    const target = row.upstream ? `${row.upstream}${row.account ? ` (${row.account})` : ""}` : "builtin";
    console.log(
      `${row.ts}  ${row.keyName.padEnd(20)} ${row.tool.padEnd(28)} ${target.padEnd(24)} ${row.outcome.padEnd(16)} ${String(row.durationMs).padStart(5)}ms${row.detail ? `  ${row.detail}` : ""}`,
    );
  }
}
db.close();
