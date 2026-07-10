import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE = "cp_dash";

interface DashSession {
  csrf: string;
  expiresAt: number;
}

export class SessionStore {
  private sessions = new Map<string, DashSession>();

  constructor(private secureCookies: boolean) {}

  create(res: Response): DashSession {
    const id = randomBytes(24).toString("base64url");
    const session: DashSession = { csrf: randomBytes(24).toString("base64url"), expiresAt: Date.now() + SESSION_TTL_MS };
    this.sessions.set(id, session);
    // Lax (not Strict): the vendor's OAuth redirect back to us is a cross-site
    // top-level navigation; POSTs are protected by the CSRF token instead.
    res.cookie(COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.secureCookies,
      maxAge: SESSION_TTL_MS,
      path: "/",
    });
    return session;
  }

  get(req: Request): DashSession | null {
    const id = parseCookie(req.headers.cookie, COOKIE);
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt < Date.now()) {
      if (id) this.sessions.delete(id);
      return null;
    }
    return session;
  }

  destroy(req: Request, res: Response): void {
    const id = parseCookie(req.headers.cookie, COOKIE);
    if (id) this.sessions.delete(id);
    res.clearCookie(COOKIE, { path: "/" });
  }

  /** Redirects browsers to the login page when no valid session exists. */
  requireSession() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const session = this.get(req);
      if (!session) {
        res.redirect("/dashboard/login");
        return;
      }
      res.locals.dashSession = session;
      next();
    };
  }

  /** For POSTs: valid session AND matching CSRF token from the form body. */
  requireCsrf() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const session = this.get(req);
      if (!session) {
        res.status(401).send("Session expired — log in again.");
        return;
      }
      if ((req.body as { csrf?: string })?.csrf !== session.csrf) {
        res.status(403).send("Invalid CSRF token — reload the dashboard and retry.");
        return;
      }
      res.locals.dashSession = session;
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
