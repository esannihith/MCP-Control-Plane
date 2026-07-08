import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface MockUpstream {
  name: string;
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * A minimal stateless MCP server used as a stand-in upstream in tests:
 * `echo` returns its input tagged with the mock's name, `boom` always fails.
 * Optionally requires a bearer token, to exercise upstream auth headers.
 */
export async function startMockUpstream(
  name: string,
  options: { port?: number; bearerToken?: string } = {},
): Promise<MockUpstream> {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    if (options.bearerToken && req.headers.authorization !== `Bearer ${options.bearerToken}`) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    const server = new McpServer({ name: `mock-${name}`, version: "0.0.1" });
    server.registerTool(
      "echo",
      { description: `Echo back a message from ${name}`, inputSchema: { message: z.string() } },
      async ({ message }) => ({ content: [{ type: "text", text: `${name}: ${message}` }] }),
    );
    server.registerTool("boom", { description: "Always fails" }, async () => {
      throw new Error("kaboom");
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer = await new Promise<Server>((resolve) => {
    const s = app.listen(options.port ?? 0, "127.0.0.1", () => resolve(s));
  });
  const { port } = httpServer.address() as AddressInfo;

  return {
    name,
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
