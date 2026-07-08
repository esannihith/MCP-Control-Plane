import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db/index.js";
import { verifyApiKey, type Connection } from "../keys.js";
import type { UpstreamManager } from "../upstream/manager.js";
import { buildMcpServer } from "./mcpServer.js";

interface GatewaySession {
  transport: StreamableHTTPServerTransport;
  connection: Connection;
}

export interface Gateway {
  router: Router;
  sessions: Map<string, GatewaySession>;
  close(): Promise<void>;
}

function jsonRpcError(res: Response, httpStatus: number, code: number, message: string): void {
  res.status(httpStatus).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function requireApiKey(db: Db) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const connection = token ? verifyApiKey(db, token) : null;
    if (!connection) {
      res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
      jsonRpcError(res, 401, -32001, "Unauthorized: valid API key required");
      return;
    }
    res.locals.connection = connection;
    next();
  };
}

export function createGateway(db: Db, manager: UpstreamManager): Gateway {
  const sessions = new Map<string, GatewaySession>();
  const router = Router();

  router.use("/mcp", requireApiKey(db));

  // A session belongs to the API key that initialized it; other keys may not touch it.
  function resolveSession(req: Request, res: Response): GatewaySession | "none" | "denied" {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string") return "none";
    const session = sessions.get(sessionId);
    if (!session) return "none";
    const connection = res.locals.connection as Connection;
    if (session.connection.keyId !== connection.keyId) return "denied";
    return session;
  }

  router.post("/mcp", async (req: Request, res: Response) => {
    const session = resolveSession(req, res);
    if (session === "denied") {
      jsonRpcError(res, 403, -32003, "Forbidden: session belongs to a different connection");
      return;
    }

    if (session !== "none") {
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.headers["mcp-session-id"] || !isInitializeRequest(req.body)) {
      jsonRpcError(res, 400, -32000, "Bad Request: no valid session; send an initialize request first");
      return;
    }

    const connection = res.locals.connection as Connection;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, connection });
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = buildMcpServer({ db, manager, connection, getSessionId: () => transport.sessionId });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET serves the SSE notification stream; DELETE terminates the session.
  const handleExisting = async (req: Request, res: Response): Promise<void> => {
    const session = resolveSession(req, res);
    if (session === "denied") {
      jsonRpcError(res, 403, -32003, "Forbidden: session belongs to a different connection");
      return;
    }
    if (session === "none") {
      jsonRpcError(res, 400, -32000, "Bad Request: unknown or missing session ID");
      return;
    }
    await session.transport.handleRequest(req, res);
  };
  router.get("/mcp", handleExisting);
  router.delete("/mcp", handleExisting);

  return {
    router,
    sessions,
    async close() {
      await Promise.allSettled([...sessions.values()].map((s) => s.transport.close()));
      sessions.clear();
    },
  };
}
