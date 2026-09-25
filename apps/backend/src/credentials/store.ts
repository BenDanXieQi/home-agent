import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { credentials } from "../db/schema";

export class CredentialStoreError extends Error {
  constructor() {
    super("Credential storage unavailable");
    this.name = "CredentialStoreError";
  }
}

/** Encrypted provider credentials. Record keys are authenticated as AAD. */
export function createCredentialStore(
  db: Database,
  loadKey: () => Promise<string>,
) {
  async function readKey() {
    const key = Buffer.from(await loadKey(), "base64");
    if (key.length !== 32) throw new CredentialStoreError();
    return key;
  }
  return {
    async read(name: string) {
      try {
        const [row] = await db
          .select()
          .from(credentials)
          .where(eq(credentials.key, name));
        if (!row) return undefined;
        const key = await readKey();
        const encrypted = Buffer.from(row.ciphertext, "base64");
        if (encrypted.length < 29) throw new CredentialStoreError();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          encrypted.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from(name));
        decipher.setAuthTag(encrypted.subarray(12, 28));
        const plain = Buffer.concat([
          decipher.update(encrypted.subarray(28)),
          decipher.final(),
        ]);
        return {
          value: JSON.parse(plain.toString("utf8")) as unknown,
        };
      } catch {
        throw new CredentialStoreError();
      }
    },
    async write(name: string, value: unknown) {
      try {
        const key = await readKey();
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(Buffer.from(name));
        const ciphertext = Buffer.concat([
          cipher.update(JSON.stringify(value), "utf8"),
          cipher.final(),
        ]);
        const data = {
          key: name,
          ciphertext: Buffer.concat([
            nonce,
            cipher.getAuthTag(),
            ciphertext,
          ]).toString("base64"),
          updatedAt: new Date(),
        };
        await db
          .insert(credentials)
          .values(data)
          .onConflictDoUpdate({ target: credentials.key, set: data });
      } catch {
        throw new CredentialStoreError();
      }
    },
    async remove(name: string) {
      try {
        await db.delete(credentials).where(eq(credentials.key, name));
      } catch {
        throw new CredentialStoreError();
      }
    },
  };
}
export type CredentialStore = ReturnType<typeof createCredentialStore>;
