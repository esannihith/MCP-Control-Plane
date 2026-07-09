import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db/index.js";
import type { Connection } from "../keys.js";
import { listAccounts, type LinkedAccount } from "../accounts/index.js";
import { getBinding, setBinding } from "../accounts/bindings.js";
import { recordAudit, type AuditOutcome } from "../audit.js";
import { getProfileForConnection, isToolAllowed } from "../profiles.js";
import type { UpstreamManager } from "../upstream/manager.js";
import { getUpstream, listExposedTools, listUpstreams, resolveTool } from "../upstream/registry.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

export { SERVER_NAME, SERVER_VERSION };

export interface GatewayContext {
  db: Db;
  manager: UpstreamManager;
  connection: Connection;
  getSessionId: () => string | undefined;
}

const BUILTIN_TOOLS: Tool[] = [
  {
    name: "control_plane_status",
    description:
      "Reports the control plane's health, this client connection, ALL proxied upstream vendor servers (with live tool counts), and current account bindings. Call this before concluding that a vendor or tool is unavailable — the catalog can grow mid-session.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_accounts",
    description:
      "Lists linked accounts per upstream server and which account this connection is currently using.",
    inputSchema: {
      type: "object",
      properties: {
        upstream: { type: "string", description: "Optional upstream name to filter by" },
      },
    },
  },
  {
    name: "switch_account",
    description:
      "Switches which linked account THIS client connection uses for an upstream server. Other clients are unaffected.",
    inputSchema: {
      type: "object",
      properties: {
        upstream: { type: "string", description: "Upstream server name, e.g. 'notion'" },
        account: { type: "string", description: "Label of the linked account to use, e.g. 'john@example.com'" },
      },
      required: ["upstream", "account"],
    },
  },
];

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const errorText = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/**
 * Builds the per-session MCP server exposed to a client connection.
 * Uses the low-level Server so upstream tools can be exposed with their
 * original JSON Schemas instead of being re-modelled.
 */
/** Shown to the model at initialize — stops clients treating this as a single-vendor proxy. */
function buildInstructions(db: Db): string {
  const vendors = listUpstreams(db, true).map((u) => u.name);
  return [
    `This server is an MCP *control plane*: one endpoint proxying multiple upstream vendor MCP servers${
      vendors.length ? ` (currently: ${vendors.join(", ")})` : ""
    }.`,
    "Vendor tools are namespaced '<vendor>_<tool>' (e.g. notion_search, linear_list_issues).",
    "Prefer this server's tools for any vendor it proxies — do NOT suggest connecting a separate vendor connector for vendors listed in control_plane_status.",
    "The vendor catalog can change mid-session; a tools/list_changed notification is sent when it does. If a vendor or tool seems missing, re-list tools and check control_plane_status before concluding it is unavailable.",
    "Each vendor may have multiple linked user accounts. Bindings are per client connection: use list_accounts to see them and switch_account to change which account THIS connection uses.",
  ].join("\n");
}

export function buildMcpServer(ctx: GatewayContext): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: buildInstructions(ctx.db) },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const profile = getProfileForConnection(ctx.db, ctx.connection.keyId);
    return {
      tools: [
        ...BUILTIN_TOOLS,
        ...listExposedTools(ctx.db)
          .filter((tool) => isToolAllowed(profile, tool.upstreamName, tool.exposedName))
          .map(
            (tool): Tool => ({
              name: tool.exposedName,
              description: tool.description ?? undefined,
              inputSchema: JSON.parse(tool.inputSchema),
            }),
          ),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const started = Date.now();
    const audit = (
      outcome: AuditOutcome,
      extra: { upstream?: string | null; account?: string | null; detail?: string | null } = {},
    ) =>
      recordAudit(ctx.db, {
        apiKeyId: ctx.connection.keyId,
        keyName: ctx.connection.keyName,
        tool: name,
        outcome,
        durationMs: Date.now() - started,
        ...extra,
      });

    if (name === "control_plane_status" || name === "list_accounts" || name === "switch_account") {
      const result =
        name === "control_plane_status"
          ? statusResult(ctx)
          : name === "list_accounts"
            ? listAccountsResult(ctx, (args as { upstream?: string })?.upstream)
            : switchAccount(ctx, args as { upstream: string; account: string });
      audit(result.isError ? "error" : "ok");
      return result;
    }

    // A tool outside the profile is indistinguishable from a nonexistent one
    // to the caller, but the audit trail records which it was.
    const resolved = resolveTool(ctx.db, name);
    const profile = getProfileForConnection(ctx.db, ctx.connection.keyId);
    if (!resolved || !isToolAllowed(profile, resolved.upstreamName, name)) {
      audit(resolved ? "denied" : "error", {
        upstream: resolved?.upstreamName,
        detail: resolved ? `blocked by profile '${profile?.name}'` : "unknown tool",
      });
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    const upstream = getUpstream(ctx.db, resolved.upstreamId);
    let accountId: number | undefined;
    let accountLabel: string | null = null;
    if (upstream?.auth_mode === "oauth") {
      const account = resolveAccountForCall(ctx, resolved.upstreamId);
      if ("required" in account) {
        audit("account_required", { upstream: resolved.upstreamName });
        return account.required;
      }
      accountId = account.id;
      accountLabel = account.label;
    }

    try {
      const result = await ctx.manager.callTool(resolved, args ?? {}, accountId);
      // detail stays null for upstream error results: no payloads in the audit log.
      audit(result.isError ? "error" : "ok", { upstream: resolved.upstreamName, account: accountLabel });
      return result;
    } catch (error) {
      audit("error", {
        upstream: resolved.upstreamName,
        account: accountLabel,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  return server;
}

/**
 * Which account should this connection use for an OAuth upstream?
 * Explicit binding wins; a single linked account is auto-bound; otherwise the
 * caller gets a structured "pick one" result to relay to the user.
 */
function resolveAccountForCall(
  ctx: GatewayContext,
  upstreamId: number,
): { id: number; label: string } | { required: CallToolResult } {
  const linked = listAccounts(ctx.db, upstreamId).filter((account) => account.linked);
  const boundId = getBinding(ctx.db, ctx.connection.keyId, upstreamId);
  const bound = boundId != null ? linked.find((account) => account.id === boundId) : undefined;
  if (bound) return { id: bound.id, label: bound.label };

  if (linked.length === 1) {
    setBinding(ctx.db, ctx.connection.keyId, upstreamId, linked[0].id);
    return { id: linked[0].id, label: linked[0].label };
  }

  const upstreamName = getUpstream(ctx.db, upstreamId)?.name ?? String(upstreamId);
  return {
    required: text({
      action_required: "select_account",
      upstream: upstreamName,
      options: linked.map((account) => account.label),
      instructions:
        linked.length === 0
          ? `No account is linked for '${upstreamName}'. Ask the user to link one: npm run account -- link ${upstreamName}`
          : `Multiple accounts are linked for '${upstreamName}'. Ask the user which one to use, then call switch_account with their choice and retry the original tool call.`,
    }),
  };
}

function switchAccount(ctx: GatewayContext, args: { upstream?: string; account?: string }): CallToolResult {
  if (!args?.upstream || !args?.account) return errorText("switch_account requires 'upstream' and 'account'");
  const upstream = listUpstreams(ctx.db).find((u) => u.name === args.upstream);
  if (!upstream) return errorText(`Unknown upstream '${args.upstream}'. Use list_accounts to see what exists.`);
  const linked = listAccounts(ctx.db, upstream.id).filter((account) => account.linked);
  const account = linked.find((a) => a.label === args.account);
  if (!account) {
    return errorText(
      `No linked account '${args.account}' at '${args.upstream}'. Linked accounts: ${
        linked.map((a) => a.label).join(", ") || "(none)"
      }`,
    );
  }
  setBinding(ctx.db, ctx.connection.keyId, upstream.id, account.id);
  return text(`This connection now uses '${account.label}' for '${upstream.name}'. Other clients are unaffected.`);
}

function listAccountsResult(ctx: GatewayContext, upstreamFilter?: string): CallToolResult {
  const upstreams = listUpstreams(ctx.db).filter(
    (u) => u.auth_mode === "oauth" && (!upstreamFilter || u.name === upstreamFilter),
  );
  if (upstreamFilter && upstreams.length === 0) return errorText(`Unknown or non-OAuth upstream '${upstreamFilter}'`);
  return text(
    upstreams.map((u) => {
      const accounts = listAccounts(ctx.db, u.id).filter((account) => account.linked);
      const boundId = getBinding(ctx.db, ctx.connection.keyId, u.id);
      return {
        upstream: u.name,
        accounts: accounts.map((account: LinkedAccount) => account.label),
        active: accounts.find((account) => account.id === boundId)?.label ?? null,
      };
    }),
  );
}

function statusResult(ctx: GatewayContext): CallToolResult {
  const bindings = listUpstreams(ctx.db)
    .filter((u) => u.auth_mode === "oauth")
    .map((u) => {
      const boundId = getBinding(ctx.db, ctx.connection.keyId, u.id);
      const label = boundId
        ? listAccounts(ctx.db, u.id).find((account) => account.id === boundId)?.label ?? null
        : null;
      return { upstream: u.name, account: label };
    });
  return text({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    connection: {
      keyName: ctx.connection.keyName,
      profile: getProfileForConnection(ctx.db, ctx.connection.keyId)?.name ?? null,
    },
    sessionId: ctx.getSessionId() ?? null,
    upstreams: ctx.manager.status(),
    bindings,
  });
}
