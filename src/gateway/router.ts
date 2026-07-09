import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db/index.js";
import { verifyApiKey, type Connection } from "../keys.js";
import type { UpstreamManager } from "../upstream/manager.js";
import { buildMcpServer } from "./mcpServer.js";

export interface GatewayOptions {
  /** Verifies OAuth access tokens issued by the control plane's auth server. */
  tokenVerifier?: OAuthTokenVerifier;
  /** Advertised in 401s so OAuth-capable clients can discover the auth server. */
  resourceMetadataUrl?: string;
}

interface GatewaySession {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof buildMcpServer>;
  connection: Connection;
}

export interface Gateway {
  router: Router;
  sessions: Map<string, GatewaySession>;
  /** Broadcasts tools/list_changed to every live session (best effort). */
  notifyToolListChanged(): Promise<void>;
  close(): Promise<void>;
}

function jsonRpcError(res: Response, httpStatus: number, code: number, message: string): void {
  res.status(httpStatus).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Accepts either a header API key (cpk_*) or an OAuth access token from our auth server. */
function requireConnection(db: Db, options: GatewayOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

    let connection: Connection | null = null;
    if (token?.startsWith("cpk_")) {
      connection = verifyApiKey(db, token);
    } else if (token && options.tokenVerifier) {
      try {
        const info = await options.tokenVerifier.verifyAccessToken(token);
        const extra = info.extra as { apiKeyId?: number; keyName?: string } | undefined;
        if (extra?.apiKeyId != null && extra.keyName) {
          connection = { keyId: extra.apiKeyId, keyName: extra.keyName };
        }
      } catch {
        connection = null;
      }
    }

    if (!connection) {
      const resourceMetadata = options.resourceMetadataUrl
        ? `, resource_metadata="${options.resourceMetadataUrl}"`
        : "";
      res.set("WWW-Authenticate", `Bearer error="invalid_token"${resourceMetadata}`);
      jsonRpcError(res, 401, -32001, "Unauthorized: valid API key or OAuth access token required");
      return;
    }
    res.locals.connection = connection;
    next();
  };
}

export function createGateway(db: Db, manager: UpstreamManager, options: GatewayOptions = {}): Gateway {
  const sessions = new Map<string, GatewaySession>();
  const router = Router();

  // Some web clients (observed with ChatGPT connectors) send MCP traffic to
  // the origin root instead of the advertised /mcp path — serve both.
  const MCP_PATHS = ["/mcp", "/"];
  const requireAuth = requireConnection(db, options);

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

  router.post(MCP_PATHS, requireAuth, async (req: Request, res: Response) => {
    const session = resolveSession(req, res);
    if (session === "denied") {
      jsonRpcError(res, 403, -32003, "Forbidden: session belongs to a different connection");
      return;
    }

    if (session !== "none") {
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // Spec: unknown/expired session IDs get 404 so conforming clients
    // re-initialize transparently (e.g. after a control-plane restart).
    if (req.headers["mcp-session-id"]) {
      jsonRpcError(res, 404, -32001, "Session not found or expired; start a new session with initialize");
      return;
    }
    if (!isInitializeRequest(req.body)) {
      jsonRpcError(res, 400, -32000, "Bad Request: no valid session; send an initialize request first");
      return;
    }

    const connection = res.locals.connection as Connection;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server, connection });
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

  async function notifyToolListChanged(): Promise<void> {
    // Best effort: a session without an open notification stream just misses it
    // and still gets fresh tools on its next tools/list.
    await Promise.allSettled([...sessions.values()].map((session) => session.server.sendToolListChanged()));
  }

  // GET serves the SSE notification stream; DELETE terminates the session.
  const handleExisting = async (req: Request, res: Response): Promise<void> => {
    const session = resolveSession(req, res);
    if (session === "denied") {
      jsonRpcError(res, 403, -32003, "Forbidden: session belongs to a different connection");
      return;
    }
    if (session === "none") {
      const hadSessionId = typeof req.headers["mcp-session-id"] === "string";
      jsonRpcError(
        res,
        hadSessionId ? 404 : 400,
        -32001,
        hadSessionId ? "Session not found or expired" : "Bad Request: missing session ID",
      );
      return;
    }
    await session.transport.handleRequest(req, res);
  };
  router.get(MCP_PATHS, requireAuth, handleExisting);
  router.delete(MCP_PATHS, requireAuth, handleExisting);

  return {
    router,
    sessions,
    notifyToolListChanged,
    async close() {
      await Promise.allSettled([...sessions.values()].map((s) => s.transport.close()));
      sessions.clear();
    },
  };
}
