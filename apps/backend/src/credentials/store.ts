import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { credentials } from "../db/schema";
import {
  createConfirmedWriter,
  createLockedTransactions,
  StorageOutcomeUnknownError,
} from "../db/transaction-outcome";

export class CredentialStoreError extends Error {
  constructor() {
    super("Credential storage unavailable");
    this.name = "CredentialStoreError";
  }
}

export class CredentialCommitUnknownError extends CredentialStoreError {}
const lockKey = (name: string) => `credentials/${name}`;

/** Encrypted provider credentials. Record keys are authenticated as AAD. */
export function createCredentialStore(
  db: Database,
  loadKey: () => Promise<string>,
) {
  const transaction = createLockedTransactions(db, 5000);
  const write = createConfirmedWriter(transaction);
  async function readKey() {
    const key = Buffer.from(await loadKey(), "base64");
    if (key.length !== 32) throw new CredentialStoreError();
    return key;
  }
  return {
    async read(name: string) {
      try {
        await write.settle();
        const [row] = await transaction(lockKey(name), (tx) =>
          tx.select().from(credentials).where(eq(credentials.key, name)),
        );
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
        await write(
          lockKey(name),
          async (tx, beforeWrite) => {
            beforeWrite();
            await tx
              .insert(credentials)
              .values(data)
              .onConflictDoUpdate({ target: credentials.key, set: data });
          },
          async (tx) => {
            const [row] = await tx
              .select({ ciphertext: credentials.ciphertext })
              .from(credentials)
              .where(eq(credentials.key, name));
            return row?.ciphertext === data.ciphertext
              ? { committed: true, value: undefined }
              : { committed: false };
          },
        );
      } catch (cause) {
        if (cause instanceof StorageOutcomeUnknownError)
          throw new CredentialCommitUnknownError();
        throw new CredentialStoreError();
      }
    },
    async remove(name: string) {
      try {
        await write(
          lockKey(name),
          async (tx, beforeWrite) => {
            beforeWrite();
            await tx.delete(credentials).where(eq(credentials.key, name));
          },
          async (tx) => {
            const [row] = await tx
              .select({ key: credentials.key })
              .from(credentials)
              .where(eq(credentials.key, name));
            return row
              ? { committed: false }
              : { committed: true, value: undefined };
          },
        );
      } catch (cause) {
        if (cause instanceof StorageOutcomeUnknownError)
          throw new CredentialCommitUnknownError();
        throw new CredentialStoreError();
      }
    },
  };
}
export type CredentialStore = ReturnType<typeof createCredentialStore>;
