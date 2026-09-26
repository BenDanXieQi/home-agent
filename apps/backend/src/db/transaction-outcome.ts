import { sql } from "drizzle-orm";
import type { Database } from ".";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The database has not yet established whether a previous write committed. */
export class StorageOutcomeUnknownError extends Error {
  constructor() {
    super("Storage write outcome is unconfirmed");
    this.name = "StorageOutcomeUnknownError";
  }
}

/** Acquiring the same transaction lock also proves the previous transaction ended. */
export function createLockedTransactions(db: Database, timeoutMs: number) {
  return <T>(key: string, run: (tx: Transaction) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('statement_timeout', ${String(timeoutMs)}, true), set_config('lock_timeout', ${String(timeoutMs)}, true), set_config('transaction_timeout', ${String(timeoutMs)}, true)`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
      return run(tx);
    });
}

/** Called through the account's serial write entry; retains only an unconfirmed commit. */
export function createConfirmedWriter<TTransaction>(
  transaction: <T>(
    key: string,
    run: (tx: TTransaction) => Promise<T>,
  ) => Promise<T>,
) {
  let pending: (() => Promise<void>) | undefined;
  return async <T>(
    key: string,
    run: (tx: TTransaction, beforeWrite: () => void) => Promise<T>,
    confirm: (
      tx: TTransaction,
    ) => Promise<{ committed: true; value: T } | { committed: false }>,
  ) => {
    await pending?.();
    let attempted = false;
    let callbackCompleted = false;
    const recover = async () => {
      try {
        const result = await transaction(key, confirm);
        pending = undefined;
        return result;
      } catch {
        throw new StorageOutcomeUnknownError();
      }
    };
    try {
      return await transaction(key, async (tx) => {
        const result = await run(tx, () => {
          attempted = true;
        });
        callbackCompleted = true;
        return result;
      });
    } catch (error) {
      // A rejected callback never reaches COMMIT; the transaction rolls it back.
      if (!attempted || !callbackCompleted) throw error;
      pending = async () => {
        await recover();
      };
      const result = await recover();
      if (result.committed) return result.value;
      throw error;
    }
  };
}
