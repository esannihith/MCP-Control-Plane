import { Router } from "express";
import type { Db } from "../db/index.js";
import type { User } from "../auth/users.js";
import type { UserSession, UserSessionStore } from "../auth/userSessions.js";

export interface ApiDeps {
  db: Db;
  sessions: UserSessionStore;
}

/**
 * The SaaS JSON API under /api. Every route requires a session; mutating
 * routes additionally require the X-CSRF-Token header (token from /api/me).
 * Functional endpoints are wired page-by-page in later parts.
 */
export function createApi(deps: ApiDeps): Router {
  const router = Router();
  const requireUser = deps.sessions.requireUser();

  router.get("/api/me", requireUser, (_req, res) => {
    const user = res.locals.user as User;
    const session = res.locals.session as UserSession;
    res.json({
      user: { email: user.email, name: user.name, avatarUrl: user.avatarUrl, slug: user.slug },
      csrf: session.csrf,
    });
  });

  return router;
}
