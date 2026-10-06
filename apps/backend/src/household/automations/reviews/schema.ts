import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { z } from "zod";
import type {
  automationReviewRequestSchema,
  automationReviewResultSchema,
  automationReviewStatusSchema,
} from "@home-agent/api/automation-reviews";

import { automations } from "../../../db/schema";

export const automationReviews = pgTable(
  "automation_reviews",
  {
    id: uuid("id").primaryKey(),
    accountId: text("account_id").notNull(),
    homeId: text("home_id").notNull(),
    revision: integer("revision").notNull(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    lastFingerprint: text("last_fingerprint"),
    activeRequestId: uuid("active_request_id"),
    nextAt: timestamp("next_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_reviews_node_idx").on(
      table.automationId,
      table.nodeId,
    ),
    index("automation_reviews_household_idx").on(table.accountId, table.homeId),
  ],
);

export const automationReviewRuns = pgTable(
  "automation_review_runs",
  {
    id: uuid("id").primaryKey(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => automationReviews.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    status: text("status")
      .$type<z.infer<typeof automationReviewStatusSchema>>()
      .notNull(),
    reason: text("reason"),
    request:
      jsonb("request").$type<z.infer<typeof automationReviewRequestSchema>>(),
    result:
      jsonb("result").$type<z.infer<typeof automationReviewResultSchema>>(),
    fingerprint: text("fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("automation_review_runs_history_idx").on(
      table.reviewId,
      table.createdAt,
    ),
  ],
);
