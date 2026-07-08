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
import type { UpstreamManager } from "../upstream/manager.js";
import { listExposedTools, resolveTool } from "../upstream/registry.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

export { SERVER_NAME, SERVER_VERSION };

export interface GatewayContext {
  db: Db;
  manager: UpstreamManager;
  connection: Connection;
  getSessionId: () => string | undefined;
}

const STATUS_TOOL: Tool = {
  name: "control_plane_status",
  description:
    "Reports the control plane's health, this client connection, and the state of proxied upstream servers.",
  inputSchema: { type: "object", properties: {} },
};

/**
 * Builds the per-session MCP server exposed to a client connection.
 * Uses the low-level Server so upstream tools can be exposed with their
 * original JSON Schemas instead of being re-modelled.
 */
export function buildMcpServer(ctx: GatewayContext): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      STATUS_TOOL,
      ...listExposedTools(ctx.db).map(
        (tool): Tool => ({
          name: tool.exposedName,
          description: tool.description ?? undefined,
          inputSchema: JSON.parse(tool.inputSchema),
        }),
      ),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    if (name === STATUS_TOOL.name) return statusResult(ctx);
    const resolved = resolveTool(ctx.db, name);
    if (!resolved) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    return ctx.manager.callTool(resolved, args ?? {});
  });

  return server;
}

function statusResult(ctx: GatewayContext): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            status: "ok",
            server: SERVER_NAME,
            version: SERVER_VERSION,
            connection: { keyName: ctx.connection.keyName },
            sessionId: ctx.getSessionId() ?? null,
            upstreams: ctx.manager.status(),
          },
          null,
          2,
        ),
      },
    ],
  };
}
