import { describe, expect, it } from "vitest";
import { Vault } from "../src/vault/index.js";

describe("Vault", () => {
  it("round-trips plaintext", () => {
    const vault = new Vault(Vault.generateKey());
    const blob = vault.encrypt("super secret token");
    expect(blob).toMatch(/^v1:/);
    expect(Vault.isEncrypted(blob)).toBe(true);
    expect(vault.decrypt(blob)).toBe("super secret token");
  });

  it("produces distinct ciphertexts for the same plaintext (random IV)", () => {
    const vault = new Vault(Vault.generateKey());
    expect(vault.encrypt("x")).not.toBe(vault.encrypt("x"));
  });

  it("detects tampering", () => {
    const vault = new Vault(Vault.generateKey());
    const blob = vault.encrypt("payload");
    const parts = blob.split(":");
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA");
    expect(() => vault.decrypt(parts.join(":"))).toThrow(/tampered|corrupted/);
  });

  it("refuses data encrypted with a different master key", () => {
    const blob = new Vault(Vault.generateKey()).encrypt("payload");
    expect(() => new Vault(Vault.generateKey()).decrypt(blob)).toThrow(/different master key/);
  });

  it("accepts hex keys and rejects short keys", () => {
    const hexKey = "a".repeat(64);
    expect(new Vault(hexKey).decrypt(new Vault(hexKey).encrypt("ok"))).toBe("ok");
    expect(() => new Vault("too-short")).toThrow(/32-byte/);
  });
});
