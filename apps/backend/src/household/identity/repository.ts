import PQueue from "p-queue";
import type { Database } from "../../db";
import {
  createConfirmedWriter,
  createLockedTransactions,
  lockTransaction,
  StorageOutcomeUnknownError,
  type Transaction,
} from "../../db/transaction-outcome";
import { mijiaHomeSelections } from "../../db/schema";
import {
  assertHouseholdBinding,
  householdBindingLock,
} from "../binding-repository";
import { householdLimits } from "../config";
import { HouseholdError } from "../errors";

export const membersLock = "household_members";

// Shared with member writes; caller already holds the household binding lock.
export function lockIdentityMembers(
  tx: Transaction,
  mode: Parameters<typeof lockTransaction>[2] = "exclusive",
) {
  return lockTransaction(tx, membersLock, mode);
}

/** Membership writes resolve a previous commit before starting another mutation. */
export function createMemberWriter(db: Database) {
  const queue = new PQueue({ concurrency: 1 });
  const bindingTransaction = createLockedTransactions(
    db,
    householdLimits.transactionMs,
    "shared",
  );
  const write = createConfirmedWriter<Transaction>((key, run) =>
    bindingTransaction(householdBindingLock, async (tx) => {
      await lockTransaction(tx, key, "exclusive");
      return run(tx);
    }),
  );
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recovering = false;
  let retryMs: number = householdLimits.memberWriteRetryMs.initial;
  let pendingQualification: (() => void) | undefined;
  function stopRecovery() {
    clearTimeout(timer);
    timer = undefined;
    pendingQualification = undefined;
    retryMs = householdLimits.memberWriteRetryMs.initial;
  }
  function scheduleRecovery() {
    if (closed || timer || recovering) return;
    timer = setTimeout(() => {
      timer = undefined;
      recovering = true;
      queue
        .add(
          async () => {
            if (!closed) await write.settle();
          },
          { priority: 1 },
        )
        .finally(() => {
          recovering = false;
          if (pendingQualification && !closed) scheduleRecovery();
        })
        .catch((error: unknown) => {
          if (!closed && !(error instanceof StorageOutcomeUnknownError))
            console.error("Membership commit recovery failed", error);
        });
    }, retryMs);
    timer.unref();
    retryMs = Math.min(retryMs * 2, householdLimits.memberWriteRetryMs.maximum);
  }
  const save = <T>(
    identity: Parameters<typeof assertHouseholdBinding>[0],
    assertCurrent: () => void,
    run: Parameters<typeof write<T>>[1],
    confirm: Parameters<typeof write<T>>[2],
    onSettled: NonNullable<Parameters<typeof write<T>>[3]>,
  ) => {
    if (closed) throw new HouseholdError("stale_session");
    if (queue.size + queue.pending >= householdLimits.memberWrites)
      throw new HouseholdError("capacity_exceeded");
    return queue.add(async () => {
      if (closed) throw new HouseholdError("stale_session");
      if (timer) {
        try {
          pendingQualification?.();
        } catch (error) {
          if (
            error instanceof HouseholdError &&
            error.reason === "stale_session"
          ) {
            clearTimeout(timer);
            timer = undefined;
          } else throw error;
        }
      }
      if (timer || (recovering && pendingQualification))
        throw new StorageOutcomeUnknownError();
      let changed = false;
      const assertQualified = () => {
        if (closed) throw new HouseholdError("stale_session");
        assertCurrent();
      };
      const qualify = async (tx: Transaction) => {
        const rows = await tx.select().from(mijiaHomeSelections).limit(2);
        assertHouseholdBinding(identity, rows);
        assertQualified();
      };
      try {
        const value = await write(
          membersLock,
          async (tx, beforeWrite) => {
            await qualify(tx);
            const result = await run(tx, () => {
              beforeWrite();
              changed = true;
            });
            assertQualified();
            return result;
          },
          async (tx) => {
            try {
              await qualify(tx);
            } catch (error) {
              if (
                error instanceof HouseholdError &&
                error.reason === "stale_session"
              )
                return { committed: false };
              throw error;
            }
            const result = await confirm(tx);
            assertQualified();
            return result;
          },
          async (result) => {
            stopRecovery();
            if (!changed) return;
            try {
              assertQualified();
            } catch (error) {
              if (
                error instanceof HouseholdError &&
                error.reason === "stale_session"
              )
                return;
              throw error;
            }
            await onSettled(result);
          },
        );
        assertQualified();
        return value;
      } catch (error) {
        if (error instanceof StorageOutcomeUnknownError && !closed) {
          pendingQualification ??= assertCurrent;
          scheduleRecovery();
        } else stopRecovery();
        throw error;
      }
    });
  };
  return Object.assign(save, {
    close() {
      closed = true;
      stopRecovery();
      return queue.onIdle();
    },
  });
}
