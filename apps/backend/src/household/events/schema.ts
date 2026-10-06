import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { z } from "zod";
import type { householdEventSubmissionSchema } from "@home-agent/api/household-events";

export const householdEvents = pgTable(
  "household_events",
  {
    id: uuid("id").primaryKey(),
    accountId: text("account_id").notNull(),
    homeId: text("home_id").notNull(),
    producerId: text("producer_id").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    eventType: text("event_type").notNull(),
    deviceId: text("device_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    submission: jsonb("submission")
      .$type<z.infer<typeof householdEventSubmissionSchema>>()
      .notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("household_events_source_identity").on(
      table.accountId,
      table.homeId,
      table.producerId,
      table.sourceEventId,
    ),
    index("household_events_query_idx").on(
      table.accountId,
      table.homeId,
      table.acceptedAt,
      table.id,
    ),
    index("household_events_type_idx").on(
      table.accountId,
      table.homeId,
      table.eventType,
      table.occurredAt,
    ),
    check(
      "household_events_valid_interval",
      sql`${table.expiresAt} > ${table.occurredAt}`,
    ),
  ],
);
