import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
