import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import type { Transaction } from "../db/transaction-outcome";

// Every table must declare its lifetime. Adding a table without a policy is a type error.
const tableLifetime = {
  credentials: "installation",
  mijiaHomeSelections: "installation",
  householdDirectories: "household",
  householdSubjects: "household",
  contextRecords: "household",
  contextEntities: "household",
  identityMembers: "household",
  identitySamples: "household",
  devicePropertyDefinitions: "household",
  devicePropertyObservations: "household",
  spaces: "household",
  passages: "household",
  observationBindings: "household",
} satisfies {
  [K in keyof typeof schema as (typeof schema)[K] extends PgTable ? K : never]:
    | "installation"
    | "household";
};

const lifetimes = new Map(Object.entries(tableLifetime));
const tables = Object.entries(schema).flatMap(([key, value]) => {
  if (!is(value, PgTable)) return [];
  const lifetime = lifetimes.get(key);
  if (!lifetime) throw new Error(`Missing table lifetime: ${key}`);
  const config = getTableConfig(value);
  if (config.schema && config.schema !== "public")
    throw new Error(`Unsupported household table schema: ${config.schema}`);
  return [{ name: config.name, lifetime }];
});

/** Runs only inside the exclusive household-binding transaction. */
export async function clearHouseholdData(tx: Transaction) {
  const actual = await tx
    .select({ name: sql<string>`tablename` })
    .from(sql`pg_catalog.pg_tables`)
    .where(sql`schemaname = 'public'`);
  const known = new Set(tables.map((table) => table.name));
  if (
    actual.length !== known.size ||
    actual.some((table) => !known.has(table.name))
  )
    throw new Error(
      "Database tables do not match the household lifetime registry",
    );
  const householdTables = tables
    .filter((table) => table.lifetime === "household")
    .map(
      (table) => sql`${sql.identifier("public")}.${sql.identifier(table.name)}`,
    );
  // Explicitly list every household table; never cascade into installation data.
  await tx.execute(
    sql`truncate table ${sql.join(householdTables, sql`, `)} restrict`,
  );
}
