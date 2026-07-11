import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { googleSignIn, MOCK_GOOGLE_CLIENT_ID, startMockGoogle, type MockGoogle } from "./mockGoogle.js";

const cleanups: (() => Promise<unknown>)[] = [];
const onCleanup = (fn: () => Promise<unknown>) => cleanups.push(fn);

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function startStack(): Promise<{ app: App; baseUrl: string; google: MockGoogle }> {
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
      googleClientId: MOCK_GOOGLE_CLIENT_ID,
      googleClientSecret: "test-secret",
      googleEndpoints: google.endpoints,
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

describe("google sign-in", () => {
  it("signs in, sets a session, and serves /api/me", async () => {
    const { baseUrl, google } = await startStack();
    const { status, cookie, location } = await googleSignIn(baseUrl, google, {
      sub: "g-1",
      email: "alice@example.com",
      name: "Alice",
    });
    expect(status).toBe(302);
    expect(location).toBe("/app");
    expect(cookie).toContain("cp_sess=");

    const me = await (await fetch(`${baseUrl}/api/me`, { headers: { cookie } })).json();
    expect(me.user.email).toBe("alice@example.com");
    expect(me.user.slug).toMatch(/^[A-Za-z0-9_-]{6,8}$/);
    expect(me.csrf).toBeTruthy();
  });

  it("reuses the user row on repeat sign-ins", async () => {
    const { app, baseUrl, google } = await startStack();
    await googleSignIn(baseUrl, google, { sub: "g-1", email: "alice@example.com" });
    await googleSignIn(baseUrl, google, { sub: "g-1", email: "alice@example.com" });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  it("returns to a same-origin next path after sign-in, never elsewhere", async () => {
    const { baseUrl, google } = await startStack();
    const good = await googleSignIn(baseUrl, google, { sub: "g-2", email: "n@example.com" }, { next: "/oauth/consent?flow=abc" });
    expect(good.location).toBe("/oauth/consent?flow=abc");

    const evil = await googleSignIn(baseUrl, google, { sub: "g-2", email: "n@example.com" }, { next: "https://evil.example" });
    expect(evil.location).toBe("/app");
    const doubleSlash = await googleSignIn(baseUrl, google, { sub: "g-2", email: "n@example.com" }, { next: "//evil.example" });
    expect(doubleSlash.location).toBe("/app");
  });

  it("rejects forged states and bad signatures", async () => {
    const { baseUrl, google } = await startStack();
    const forged = await fetch(`${baseUrl}/auth/google/callback?code=x&state=forged`, { redirect: "manual" });
    expect(forged.status).toBe(400);

    const bad = await googleSignIn(baseUrl, google, { sub: "g-3", email: "eve@example.com" }, { badSignature: true });
    expect(bad.status).toBe(401);
    expect(bad.cookie).toBe("");
  });

  it("rejects unauthenticated /api/me and kills the session on logout", async () => {
    const { baseUrl, google } = await startStack();
    expect((await fetch(`${baseUrl}/api/me`)).status).toBe(401);

    const { cookie } = await googleSignIn(baseUrl, google, { sub: "g-4", email: "bob@example.com" });
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

  it("refuses a pre-SaaS database", async () => {
    const dbPath = `${process.env.TEMP ?? "/tmp"}/cp-presaas-${Date.now()}.db`;
    onCleanup(async () => {
      for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
    });
    const Database = (await import("better-sqlite3")).default;
    const old = new Database(dbPath);
    old.exec("CREATE TABLE migrations (id INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO migrations (id) VALUES (8);");
    old.close();
    await expect(buildApp(loadConfig({ dbPath, port: 0 }))).rejects.toThrow(/pre-SaaS/);
  });
});
