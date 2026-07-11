import { randomBytes } from "node:crypto";
import type { Db } from "../db/index.js";

export interface User {
  id: number;
  googleSub: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  slug: string;
}

interface UserRow {
  id: number;
  google_sub: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  slug: string;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  googleSub: row.google_sub,
  email: row.email,
  name: row.name,
  avatarUrl: row.avatar_url,
  slug: row.slug,
});

export interface GoogleClaims {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

export function upsertGoogleUser(db: Db, claims: GoogleClaims): User {
  const existing = db.prepare("SELECT * FROM users WHERE google_sub = ?").get(claims.sub) as UserRow | undefined;
  if (existing) {
    db.prepare("UPDATE users SET email = ?, name = ?, avatar_url = ?, last_login_at = datetime('now') WHERE id = ?").run(
      claims.email,
      claims.name ?? existing.name,
      claims.picture ?? existing.avatar_url,
      existing.id,
    );
    return toUser({ ...existing, email: claims.email, name: claims.name ?? existing.name, avatar_url: claims.picture ?? existing.avatar_url });
  }
  const slug = randomBytes(5).toString("base64url");
  const result = db
    .prepare(
      "INSERT INTO users (google_sub, email, name, avatar_url, slug, last_login_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
    )
    .run(claims.sub, claims.email, claims.name ?? null, claims.picture ?? null, slug);
  return {
    id: Number(result.lastInsertRowid),
    googleSub: claims.sub,
    email: claims.email,
    name: claims.name ?? null,
    avatarUrl: claims.picture ?? null,
    slug,
  };
}

export function getUserById(db: Db, id: number): User | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

/**
 * Pre-SaaS rows have user_id NULL. The configured owner adopts them all on
 * first sign-in, so an existing single-tenant deployment keeps working with
 * its data under the owner's new account.
 */
export function claimLegacyData(db: Db, user: User, ownerEmail: string | undefined): boolean {
  if (!ownerEmail || user.email.toLowerCase() !== ownerEmail.toLowerCase()) return false;
  const claim = db.transaction(() => {
    let changes = 0;
    for (const table of ["upstreams", "api_keys", "profiles", "audit_log"]) {
      changes += db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(user.id).changes;
    }
    return changes;
  });
  return claim() > 0;
}
