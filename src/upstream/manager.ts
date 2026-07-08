import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db/index.js";
import { SERVER_VERSION } from "../version.js";
import { listUpstreams, refreshUpstreamTools, type ResolvedTool, type UpstreamRow } from "./registry.js";

export interface UpstreamStatus {
  name: string;
  url: string;
  connected: boolean;
  toolCount: number;
}

interface UpstreamConnection {
  row: UpstreamRow;
  client: Client | null;
}

/**
 * Owns the control plane's MCP client connections to upstream servers:
 * connect, ingest tool lists into the registry, proxy calls, and lazily
 * reconnect when an upstream dropped.
 */
export class UpstreamManager {
  private connections = new Map<number, UpstreamConnection>();

  constructor(private db: Db) {}

  /** Connects all enabled upstreams; failures leave the upstream registered but disconnected. */
  async start(): Promise<void> {
    const rows = listUpstreams(this.db, true);
    await Promise.allSettled(rows.map((row) => this.connect(row)));
  }

  async stop(): Promise<void> {
    await Promise.allSettled(
      [...this.connections.values()].map((connection) => connection.client?.close()),
    );
    this.connections.clear();
  }

  private async connect(row: UpstreamRow): Promise<Client> {
    const connection: UpstreamConnection = this.connections.get(row.id) ?? { row, client: null };
    this.connections.set(row.id, connection);

    const client = new Client({ name: "mcp-control-plane", version: SERVER_VERSION });
    const transport = new StreamableHTTPClientTransport(
      new URL(row.url),
      row.bearer_token
        ? { requestInit: { headers: { Authorization: `Bearer ${row.bearer_token}` } } }
        : undefined,
    );
    await client.connect(transport);
    client.onclose = () => {
      if (connection.client === client) connection.client = null;
    };

    const { tools } = await client.listTools();
    refreshUpstreamTools(this.db, row, tools);
    connection.client = client;
    return client;
  }

  private async reconnect(upstreamId: number): Promise<Client> {
    const row = listUpstreams(this.db, true).find((r) => r.id === upstreamId);
    if (!row) throw new Error(`Upstream ${upstreamId} is not registered or is disabled`);
    const existing = this.connections.get(upstreamId)?.client;
    if (existing) await existing.close().catch(() => {});
    return this.connect(row);
  }

  async callTool(resolved: ResolvedTool, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const connection = this.connections.get(resolved.upstreamId);
      const client = connection?.client ?? (await this.reconnect(resolved.upstreamId));
      return (await client.callTool({ name: resolved.originalName, arguments: args })) as CallToolResult;
    } catch (error) {
      // A JSON-RPC error means the upstream received and rejected the call — never retry those.
      // Transport-level failures get one reconnect attempt, then degrade to a tool error result.
      if (error instanceof McpError) throw error;
      try {
        const client = await this.reconnect(resolved.upstreamId);
        return (await client.callTool({ name: resolved.originalName, arguments: args })) as CallToolResult;
      } catch (retryError) {
        if (retryError instanceof McpError) throw retryError;
        const message = retryError instanceof Error ? retryError.message : String(retryError);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Upstream '${resolved.upstreamName}' is unavailable: ${message}`,
            },
          ],
        };
      }
    }
  }

  status(): UpstreamStatus[] {
    return listUpstreams(this.db).map((row) => {
      const toolCount = (
        this.db.prepare("SELECT COUNT(*) AS n FROM upstream_tools WHERE upstream_id = ?").get(row.id) as {
          n: number;
        }
      ).n;
      return {
        name: row.name,
        url: row.url,
        connected: this.connections.get(row.id)?.client != null,
        toolCount,
      };
    });
  }
}
