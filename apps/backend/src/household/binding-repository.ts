import { z } from "zod";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "../db";
import { mijiaHomeSelections } from "../db/schema";
import {
  createLockedTransactions,
  transactionTimeouts,
  transactionLock,
  type Transaction,
} from "../db/transaction-outcome";
import type { DirectoryCandidate } from "./directory";
import { householdLimits } from "./config";
import { HouseholdError } from "./errors";

export const householdBindingLock = "household_binding";

type BindingIdentity = Pick<DirectoryCandidate, "accountId" | "homeId">;

export function assertHouseholdBinding(
  identity: BindingIdentity,
  rows: Pick<
    typeof mijiaHomeSelections.$inferSelect,
    "accountKey" | "homeId"
  >[],
) {
  const binding = rows[0];
  if (
    rows.length !== 1 ||
    binding?.accountKey !== identity.accountId ||
    binding.homeId !== identity.homeId
  )
    throw new HouseholdError("stale_session");
}

/** Hold shared binding access while operating on the current household's data. */
export function createHouseholdBindingAccess(db: Database) {
  const transaction = createLockedTransactions(
    db,
    householdLimits.transactionMs,
    "shared",
  );
  return <T>(
    identity: BindingIdentity,
    assertCurrent: () => void,
    run: (tx: Transaction) => Promise<T>,
  ) =>
    transaction(householdBindingLock, async (tx) => {
      assertCurrent();
      const rows = await tx.select().from(mijiaHomeSelections).limit(2);
      assertHouseholdBinding(identity, rows);
      const result = await run(tx);
      assertCurrent();
      return result;
    });
}

/** Native read transactions allow callers to consume Postgres.js cursors under the binding lock. */
export function createHouseholdBindingRead(db: Database) {
  const dialect = new PgDialect();
  return <T>(
    identity: BindingIdentity,
    assertCurrent: () => void,
    read: (
      tx: Parameters<Parameters<Database["$client"]["begin"]>[1]>[0],
    ) => Promise<T>,
  ) =>
    db.$client.begin("read only", async (tx) => {
      assertCurrent();
      for (const statement of [
        transactionTimeouts(householdLimits.transactionMs),
        transactionLock(householdBindingLock, "shared"),
      ]) {
        const compiled = dialect.sqlToQuery(statement);
        await tx.unsafe(
          compiled.sql,
          z.array(z.string()).parse(compiled.params),
        );
      }
      assertCurrent();
      const rows = await tx<
        Pick<typeof mijiaHomeSelections.$inferSelect, "accountKey" | "homeId">[]
      >`
      select account_key as "accountKey", home_id as "homeId"
      from mijia_home_selections limit 2
    `;
      assertHouseholdBinding(identity, rows);
      const result = await read(tx);
      assertCurrent();
      return result;
    });
}
