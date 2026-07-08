import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

/**
 * AES-256-GCM secret store. Ciphertext format:
 *   v1:<keyId>:<iv>:<ciphertext>:<authTag>   (base64url fields)
 * The keyId (hash prefix of the master key) makes key rotation detectable:
 * decrypting with the wrong key fails loudly instead of producing garbage.
 */
export class Vault {
  private readonly key: Buffer;
  private readonly keyId: string;

  constructor(masterKey: string) {
    this.key = decodeMasterKey(masterKey);
    this.keyId = createHash("sha256").update(this.key).digest("hex").slice(0, 8);
  }

  static generateKey(): string {
    return randomBytes(32).toString("base64url");
  }

  static isEncrypted(value: string): boolean {
    return value.startsWith(`${VERSION}:`);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [
      VERSION,
      this.keyId,
      iv.toString("base64url"),
      ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join(":");
  }

  decrypt(blob: string): string {
    const [version, keyId, iv, ciphertext, authTag] = blob.split(":");
    if (version !== VERSION || !authTag) {
      throw new Error("Vault: unrecognized ciphertext format");
    }
    if (keyId !== this.keyId) {
      throw new Error("Vault: data was encrypted with a different master key");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(authTag, "base64url"));
    try {
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      throw new Error("Vault: decryption failed (data is tampered or corrupted)");
    }
  }
}

function decodeMasterKey(masterKey: string): Buffer {
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/.test(masterKey)) candidates.push(Buffer.from(masterKey, "hex"));
  candidates.push(Buffer.from(masterKey, "base64url"), Buffer.from(masterKey, "base64"));
  const key = candidates.find((buffer) => buffer.length === 32);
  if (!key) {
    throw new Error(
      "CP_MASTER_KEY must be a 32-byte key in base64url, base64, or hex. Generate one with: npm run key -- master",
    );
  }
  return key;
}
