import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import type { windowSummarySchema } from "@home-agent/api/contracts";

export const perceptionWindows = pgTable(
  "perception_windows",
  {
    id: uuid("id").primaryKey(),
    accountId: text("account_id").notNull(),
    homeId: text("home_id").notNull(),
    deviceId: text("device_id").notNull(),
    channel: integer("channel").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }).notNull(),
    observedStartAt: numeric("observed_start_at", { mode: "number" }).notNull(),
    observedEndAt: numeric("observed_end_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    summary: jsonb("summary")
      .$type<z.infer<typeof windowSummarySchema>>()
      .notNull(),
  },
  (table) => [
    index("perception_windows_source_time").on(
      table.accountId,
      table.homeId,
      table.deviceId,
      table.channel,
      table.startedAt,
      table.id,
    ),
    index("perception_windows_history_time").on(
      table.accountId,
      table.homeId,
      table.startedAt,
      table.id,
    ),
    index("perception_windows_observed_range").using(
      "gist",
      sql`numrange(${table.observedStartAt}, ${table.observedEndAt}, '[]')`,
    ),
    index("perception_windows_expiry").on(table.expiresAt),
  ],
);
