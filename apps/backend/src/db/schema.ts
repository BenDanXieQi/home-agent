import {
  pgTable,
  text,
  timestamp,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";

export const credentials = pgTable("credentials", {
  key: text("key").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const mijiaHomeSelections = pgTable("mijia_home_selections", {
  accountKey: text("account_key").primaryKey(),
  homeId: text("home_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const householdDirectories = pgTable(
  "household_directories",
  {
    accountId: text("account_id").notNull(),
    homeId: text("home_id").notNull(),
    directory: jsonb("directory").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.homeId] })],
);
