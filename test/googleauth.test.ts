import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createApiKey } from "../src/keys.js";
import { addUpstream } from "../src/upstream/registry.js";

const CLIENT_ID = "test-google-client";
const cleanups: (() => Promise<unknown>)[] = [];
const onCleanup = (fn: () => Promise<unknown>) => cleanups.push(fn);

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

interface MockGoogle {
  base: string;
  /** Registers a code the token endpoint will exchange for a signed id_token. */
  issueCode(claims: Record<string, unknown>, nonce: string, options?: { badSignature?: boolean }): string;
  close(): Promise<void>;
}

async function startMockGoogle(): Promise<MockGoogle> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const { privateKey: rogueKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "mock-key", alg: "RS256", use: "sig" };
  const codes = new Map<string, { claims: Record<string, unknown>; nonce: string; key: CryptoKey }>();

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.get("/jwks", (_req, res) => res.json({ keys: [jwk] }));
  let base = "";
  app.post("/token", async (req, res) => {
    const pending = codes.get((req.body as { code: string }).code);
    if (!pending) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    const idToken = await new SignJWT({ ...pending.claims, nonce: pending.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "mock-key" })
      .setIssuer(base)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pending.key);
    res.json({ access_token: "ignored", id_token: idToken, token_type: "Bearer" });
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    issueCode(claims, nonce, options = {}) {
      const code = `gc_${randomBytes(8).toString("hex")}`;
      codes.set(code, { claims, nonce, key: options.badSignature ? rogueKey : privateKey });
      return code;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function startStack(ownerEmail?: string): Promise<{ app: App; baseUrl: string; google: MockGoogle }> {
  const google = await startMockGoogle();
  onCleanup(() => google.close());
  const dbPath = `${process.env.TEMP ?? "/tmp"}/cp-gauth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  onCleanup(async () => {
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
  });
  const app = await buildApp(
    loadConfig({
      dbPath,
      port: 0,
      googleClientId: CLIENT_ID,
      googleClientSecret: "test-secret",
      ownerEmail,
      googleEndpoints: {
        authorizationEndpoint: `${google.base}/authorize`,
        tokenEndpoint: `${google.base}/token`,
        jwksUri: `${google.base}/jwks`,
        issuer: google.base,
      },
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  onCleanup(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { app, baseUrl, google };
}

/** Runs the full sign-in dance like a browser; returns the session cookie. */
async function signIn(
  baseUrl: string,
  google: MockGoogle,
  claims: Record<string, unknown>,
  options?: { badSignature?: boolean },
): Promise<{ status: number; cookie: string }> {
  const start = await fetch(`${baseUrl}/auth/google`, { redirect: "manual" });
  const authorizeUrl = new URL(start.headers.get("location")!);
  const state = authorizeUrl.searchParams.get("state")!;
  const nonce = authorizeUrl.searchParams.get("nonce")!;
  const code = google.issueCode(claims, nonce, options);
  const callback = await fetch(`${baseUrl}/auth/google/callback?code=${code}&state=${state}`, { redirect: "manual" });
  return { status: callback.status, cookie: callback.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

describe("google sign-in", () => {
  it("signs in, sets a session, and serves /api/me", async () => {
    const { baseUrl, google } = await startStack();
    const { status, cookie } = await signIn(baseUrl, google, {
      sub: "g-1",
      email: "alice@example.com",
      name: "Alice",
    });
    expect(status).toBe(302);
    expect(cookie).toContain("cp_sess=");

    const me = await (await fetch(`${baseUrl}/api/me`, { headers: { cookie } })).json();
    expect(me.user.email).toBe("alice@example.com");
    expect(me.user.slug).toMatch(/^[A-Za-z0-9_-]{6,8}$/);
    expect(me.csrf).toBeTruthy();
  });

  it("reuses the user row on repeat sign-ins", async () => {
    const { app, baseUrl, google } = await startStack();
    await signIn(baseUrl, google, { sub: "g-1", email: "alice@example.com" });
    await signIn(baseUrl, google, { sub: "g-1", email: "alice@example.com" });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  it("lets the configured owner claim pre-SaaS data, exactly once", async () => {
    const { app, baseUrl, google } = await startStack("owner@example.com");
    // Pre-tenancy rows: user_id NULL.
    addUpstream(app.db, "legacy-vendor", "http://127.0.0.1:1/mcp");
    createApiKey(app.db, "legacy-key");

    await signIn(baseUrl, google, { sub: "g-stranger", email: "stranger@example.com" });
    const unclaimed = app.db.prepare("SELECT COUNT(*) AS n FROM upstreams WHERE user_id IS NULL").get() as { n: number };
    expect(unclaimed.n).toBe(1);

    await signIn(baseUrl, google, { sub: "g-owner", email: "Owner@Example.com" });
    const owner = app.db.prepare("SELECT id FROM users WHERE email = 'Owner@Example.com'").get() as { id: number };
    expect(app.db.prepare("SELECT user_id FROM upstreams WHERE name = 'legacy-vendor'").get()).toEqual({
      user_id: owner.id,
    });
    expect(app.db.prepare("SELECT user_id FROM api_keys WHERE name = 'legacy-key'").get()).toEqual({
      user_id: owner.id,
    });
  });

  it("rejects forged states and bad signatures", async () => {
    const { baseUrl, google } = await startStack();
    const forged = await fetch(`${baseUrl}/auth/google/callback?code=x&state=forged`, { redirect: "manual" });
    expect(forged.status).toBe(400);

    const bad = await signIn(baseUrl, google, { sub: "g-2", email: "eve@example.com" }, { badSignature: true });
    expect(bad.status).toBe(401);
    expect(bad.cookie).toBe("");
  });

  it("rejects unauthenticated /api/me and kills the session on logout", async () => {
    const { baseUrl, google } = await startStack();
    expect((await fetch(`${baseUrl}/api/me`)).status).toBe(401);

    const { cookie } = await signIn(baseUrl, google, { sub: "g-3", email: "bob@example.com" });
    const me = await (await fetch(`${baseUrl}/api/me`, { headers: { cookie } })).json();
    await fetch(`${baseUrl}/auth/logout`, { method: "POST", headers: { cookie, "X-CSRF-Token": me.csrf } });
    expect((await fetch(`${baseUrl}/api/me`, { headers: { cookie } })).status).toBe(401);
  });

  it("rate-limits the auth endpoints", async () => {
    const { baseUrl } = await startStack();
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) {
      limited = (await fetch(`${baseUrl}/auth/google`, { redirect: "manual" })).status === 429;
    }
    expect(limited).toBe(true);
  });

  it("redirects browsers on the root path to /app, leaving MCP traffic alone", async () => {
    const { baseUrl } = await startStack();
    const browser = await fetch(baseUrl, { redirect: "manual", headers: { accept: "text/html,*/*" } });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("location")).toBe("/app");
  });
});
