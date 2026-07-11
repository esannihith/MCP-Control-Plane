import { randomBytes } from "node:crypto";
import { Router } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config, GoogleEndpointsConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { upsertGoogleUser } from "./users.js";
import type { UserSessionStore } from "./userSessions.js";

const GOOGLE_DEFAULTS: GoogleEndpointsConfig = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
  issuer: ["https://accounts.google.com", "accounts.google.com"],
};

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * "Sign in with Google" via the OIDC authorization-code flow. The id_token
 * signature is verified against Google's JWKS (jose); state + nonce guard the
 * round-trip. Endpoints are injectable so tests run a local mock Google.
 */
export function createGoogleAuth(db: Db, config: Config, sessions: UserSessionStore): Router {
  const endpoints = config.googleEndpoints ?? GOOGLE_DEFAULTS;
  const jwks = createRemoteJWKSet(new URL(endpoints.jwksUri));
  const redirectUrl = `${config.publicUrl}/auth/google/callback`;
  const pending = new Map<string, { nonce: string; next: string; createdAt: number }>();
  const router = Router();

  router.get("/auth/google", (req, res) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      res.status(503).send("Google sign-in is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
      return;
    }
    for (const [key, value] of pending) {
      if (Date.now() - value.createdAt > STATE_TTL_MS) pending.delete(key);
    }
    // Same-origin relative paths only — anything else invites open redirects.
    const rawNext = String(req.query.next ?? "");
    const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/app";
    const state = randomBytes(16).toString("base64url");
    const nonce = randomBytes(16).toString("base64url");
    pending.set(state, { nonce, next, createdAt: Date.now() });
    const url = new URL(endpoints.authorizationEndpoint);
    url.searchParams.set("client_id", config.googleClientId);
    url.searchParams.set("redirect_uri", redirectUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    res.redirect(url.toString());
  });

  router.get("/auth/google/callback", async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;
    const flow = state ? pending.get(state) : undefined;
    if (flow) pending.delete(state);
    if (error || !code || !flow || Date.now() - flow.createdAt > STATE_TTL_MS) {
      res.status(400).send(`Sign-in failed: ${error ?? "invalid or expired state"}. Try again from /app/login.`);
      return;
    }
    try {
      const tokenResponse = await fetch(endpoints.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: config.googleClientId!,
          client_secret: config.googleClientSecret!,
          redirect_uri: redirectUrl,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenResponse.ok) throw new Error(`token exchange failed: ${tokenResponse.status}`);
      const { id_token } = (await tokenResponse.json()) as { id_token?: string };
      if (!id_token) throw new Error("no id_token in token response");

      const { payload } = await jwtVerify(id_token, jwks, {
        issuer: endpoints.issuer,
        audience: config.googleClientId!,
      });
      if (payload.nonce !== flow.nonce) throw new Error("nonce mismatch");
      if (!payload.sub || typeof payload.email !== "string") throw new Error("id_token missing sub/email");
      if (payload.email_verified === false) throw new Error("Google account email is unverified");

      const user = upsertGoogleUser(db, {
        sub: payload.sub,
        email: payload.email,
        name: typeof payload.name === "string" ? payload.name : undefined,
        picture: typeof payload.picture === "string" ? payload.picture : undefined,
      });
      sessions.create(res, user.id);
      res.redirect(flow.next);
    } catch (verifyError) {
      res
        .status(401)
        .send(`Sign-in failed: ${verifyError instanceof Error ? verifyError.message : "verification error"}`);
    }
  });

  router.post("/auth/logout", (req, res) => {
    sessions.destroy(req, res);
    res.json({ ok: true });
  });

  return router;
}
