import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { GoogleEndpointsConfig } from "../src/config.js";

export const MOCK_GOOGLE_CLIENT_ID = "test-google-client";

export interface MockGoogle {
  base: string;
  endpoints: GoogleEndpointsConfig;
  /** Registers a code the token endpoint will exchange for a signed id_token. */
  issueCode(claims: Record<string, unknown>, nonce: string, options?: { badSignature?: boolean }): string;
  close(): Promise<void>;
}

/** A local "Google": JWKS endpoint + token endpoint issuing real signed id_tokens. */
export async function startMockGoogle(): Promise<MockGoogle> {
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
      .setAudience(MOCK_GOOGLE_CLIENT_ID)
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
    endpoints: {
      authorizationEndpoint: `${base}/authorize`,
      tokenEndpoint: `${base}/token`,
      jwksUri: `${base}/jwks`,
      issuer: base,
    },
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

/** Drives the full sign-in dance like a browser; returns the session cookie. */
export async function googleSignIn(
  baseUrl: string,
  google: MockGoogle,
  claims: Record<string, unknown>,
  options?: { badSignature?: boolean; next?: string },
): Promise<{ status: number; cookie: string; location: string | null }> {
  const nextParam = options?.next ? `?next=${encodeURIComponent(options.next)}` : "";
  const start = await fetch(`${baseUrl}/auth/google${nextParam}`, { redirect: "manual" });
  const authorizeUrl = new URL(start.headers.get("location")!);
  const state = authorizeUrl.searchParams.get("state")!;
  const nonce = authorizeUrl.searchParams.get("nonce")!;
  const code = google.issueCode(claims, nonce, options);
  const callback = await fetch(`${baseUrl}/auth/google/callback?code=${code}&state=${state}`, { redirect: "manual" });
  return {
    status: callback.status,
    cookie: callback.headers.get("set-cookie")?.split(";")[0] ?? "",
    location: callback.headers.get("location"),
  };
}
