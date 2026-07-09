import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/index.js";
import { getSetting, setSetting } from "../db/settings.js";

const SETTING_KEY = "owner_password";

export function hasOwnerPassword(db: Db): boolean {
  return getSetting(db, SETTING_KEY) != null;
}

export function setOwnerPassword(db: Db, password: string): void {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  setSetting(db, SETTING_KEY, `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`);
}

export function verifyOwnerPassword(db: Db, password: string): boolean {
  const stored = getSetting(db, SETTING_KEY);
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}
