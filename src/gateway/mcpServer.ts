import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connection } from "../keys.js";

export const SERVER_NAME = "mcp-control-plane";
export const SERVER_VERSION = "0.1.0";

/**
 * Builds the per-session MCP server exposed to a client connection.
 * Part 1 only carries the built-in status tool; upstream proxying arrives in Part 2.
 */
export function buildMcpServer(connection: Connection, getSessionId: () => string | undefined): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "control_plane_status",
    {
      title: "Control plane status",
      description:
        "Reports the control plane's health and details about this client connection (key name, session).",
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "ok",
              server: SERVER_NAME,
              version: SERVER_VERSION,
              connection: { keyName: connection.keyName },
              sessionId: getSessionId() ?? null,
              upstreams: [],
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}
