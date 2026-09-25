import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const credentials = pgTable("credentials", {
  key: text("key").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
