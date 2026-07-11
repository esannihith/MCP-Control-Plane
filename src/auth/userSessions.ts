import { createHash, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Db } from "../db/index.js";
import { getUserById, type User } from "./users.js";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const COOKIE = "cp_sess";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export interface UserSession {
  userId: number;
  csrf: string;
}

/** DB-backed SaaS sessions: hashed at rest, survive deploys, one row per login. */
export class UserSessionStore {
  constructor(
    private db: Db,
    private secureCookies: boolean,
  ) {}

  create(res: Response, userId: number): void {
    const id = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO user_sessions (id_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(id), userId, randomBytes(24).toString("base64url"), nowSeconds() + SESSION_TTL_SECONDS);
    // Opportunistic cleanup keeps the table from growing unbounded.
    this.db.prepare("DELETE FROM user_sessions WHERE expires_at < ?").run(nowSeconds());
    res.cookie(COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.secureCookies,
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: "/",
    });
  }

  get(req: Request): UserSession | null {
    const id = parseCookie(req.headers.cookie, COOKIE);
    if (!id) return null;
    const row = this.db
      .prepare("SELECT user_id, csrf FROM user_sessions WHERE id_hash = ? AND expires_at > ?")
      .get(sha256(id), nowSeconds()) as { user_id: number; csrf: string } | undefined;
    return row ? { userId: row.user_id, csrf: row.csrf } : null;
  }

  destroy(req: Request, res: Response): void {
    const id = parseCookie(req.headers.cookie, COOKIE);
    if (id) this.db.prepare("DELETE FROM user_sessions WHERE id_hash = ?").run(sha256(id));
    res.clearCookie(COOKIE, { path: "/" });
  }

  /** For /api routes: 401 JSON when unauthenticated; attaches user + session. */
  requireUser() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const session = this.get(req);
      const user = session ? getUserById(this.db, session.userId) : null;
      if (!session || !user) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      res.locals.user = user satisfies User;
      res.locals.session = session;
      next();
    };
  }

  /** For mutating /api routes: session + X-CSRF-Token header must match. */
  requireCsrf() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const session = res.locals.session as UserSession | undefined;
      if (!session || req.headers["x-csrf-token"] !== session.csrf) {
        res.status(403).json({ error: "csrf" });
        return;
      }
      next();
    };
  }
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}
