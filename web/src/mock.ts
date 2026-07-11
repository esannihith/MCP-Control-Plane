/**
 * Skeleton-phase fixtures. Every page renders from these until its part wires
 * the real /api endpoints; shapes mirror what those endpoints will return.
 */

export interface CatalogEntry {
  slug: string;
  name: string;
  description: string;
  auth: "oauth" | "none";
  tools: { total: number; read: number; write: number };
}

export const catalog: CatalogEntry[] = [
  { slug: "notion", name: "Notion", description: "Pages, databases, comments, and search across your workspaces.", auth: "oauth", tools: { total: 20, read: 12, write: 8 } },
  { slug: "linear", name: "Linear", description: "Issues, projects, cycles, documents, and team workflows.", auth: "oauth", tools: { total: 47, read: 31, write: 16 } },
  { slug: "github", name: "GitHub", description: "Repositories, issues, pull requests, and code search.", auth: "oauth", tools: { total: 36, read: 25, write: 11 } },
  { slug: "asana", name: "Asana", description: "Tasks, projects, and portfolios for team coordination.", auth: "oauth", tools: { total: 22, read: 14, write: 8 } },
  { slug: "sentry", name: "Sentry", description: "Errors, issues, and performance monitoring queries.", auth: "oauth", tools: { total: 14, read: 12, write: 2 } },
  { slug: "atlassian", name: "Atlassian", description: "Jira issues and Confluence pages in one connector.", auth: "oauth", tools: { total: 28, read: 18, write: 10 } },
];

export interface MyConnector {
  name: string;
  url: string;
  status: "connected" | "disconnected";
  toolCount: number;
  accounts: string[];
}

export const myConnectors: MyConnector[] = [
  { name: "notion", url: "https://mcp.notion.com/mcp", status: "connected", toolCount: 20, accounts: ["john@gmail.com", "jane@gmail.com"] },
  { name: "linear", url: "https://mcp.linear.app/mcp", status: "connected", toolCount: 47, accounts: ["john@acme.dev"] },
];

export interface Connection {
  name: string;
  kind: "oauth" | "api-key";
  client: string;
  policy: "full" | "read_only" | "reads_plus_granted";
  toolMode: "meta" | "full";
  lastUsed: string;
  created: string;
}

export const connections: Connection[] = [
  { name: "Claude — personal", kind: "oauth", client: "claude.ai", policy: "reads_plus_granted", toolMode: "meta", lastUsed: "2 min ago", created: "2026-07-10" },
  { name: "ChatGPT", kind: "oauth", client: "ChatGPT", policy: "read_only", toolMode: "meta", lastUsed: "1 h ago", created: "2026-07-10" },
  { name: "antigravity-ide", kind: "api-key", client: "API key", policy: "full", toolMode: "full", lastUsed: "yesterday", created: "2026-07-09" },
];

export interface LinkedAccount {
  connector: string;
  label: string;
  identity: string | null;
  linked: string;
}

export const accounts: LinkedAccount[] = [
  { connector: "notion", label: "john@gmail.com", identity: "John Doe (john@gmail.com)", linked: "2026-07-09" },
  { connector: "notion", label: "jane@gmail.com", identity: null, linked: "2026-07-10" },
  { connector: "linear", label: "john@acme.dev", identity: "John Doe (Acme)", linked: "2026-07-10" },
];

export interface PermissionTool {
  name: string;
  write: boolean;
  granted: boolean;
}

export const permissionTools: Record<string, PermissionTool[]> = {
  notion: [
    { name: "notion_search", write: false, granted: true },
    { name: "notion_fetch", write: false, granted: true },
    { name: "notion_create_pages", write: true, granted: true },
    { name: "notion_update_page", write: true, granted: false },
    { name: "notion_delete_blocks", write: true, granted: false },
  ],
  linear: [
    { name: "linear_list_issues", write: false, granted: true },
    { name: "linear_get_issue", write: false, granted: true },
    { name: "linear_save_issue", write: true, granted: false },
    { name: "linear_delete_comment", write: true, granted: false },
  ],
};

export interface AuditRow {
  ts: string;
  connection: string;
  tool: string;
  target: string;
  outcome: "ok" | "error" | "denied" | "account_required";
  ms: number;
}

export const auditRows: AuditRow[] = [
  { ts: "18:42:11", connection: "Claude — personal", tool: "notion_search", target: "notion (john@gmail.com)", outcome: "ok", ms: 412 },
  { ts: "18:41:58", connection: "Claude — personal", tool: "switch_account", target: "builtin", outcome: "ok", ms: 3 },
  { ts: "18:40:02", connection: "ChatGPT", tool: "notion_create_pages", target: "notion (jane@gmail.com)", outcome: "denied", ms: 2 },
  { ts: "18:31:47", connection: "antigravity-ide", tool: "linear_list_issues", target: "linear (john@acme.dev)", outcome: "ok", ms: 655 },
  { ts: "18:30:12", connection: "ChatGPT", tool: "notion_fetch", target: "notion", outcome: "account_required", ms: 4 },
  { ts: "18:22:03", connection: "antigravity-ide", tool: "linear_get_issue", target: "linear (john@acme.dev)", outcome: "error", ms: 10021 },
];
