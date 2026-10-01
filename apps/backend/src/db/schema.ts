import { sql } from "drizzle-orm";
import { contextEntityTypeSchema } from "@home-agent/api/household-context";
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  jsonb,
  primaryKey,
  uuid,
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

export const householdSubjectKind = pgEnum("household_subject_kind", [
  "person",
  "pet",
]);
export const contextKind = pgEnum("context_kind", [
  "observation",
  "assessment",
]);
export const contextCertainty = pgEnum("context_certainty", [
  "supported",
  "tentative",
  "unknown",
  "conflicting",
]);
export const contextEntityType = pgEnum(
  "context_entity_type",
  contextEntityTypeSchema.enum,
);
export const contextEntityRole = pgEnum("context_entity_role", [
  "subject",
  "participant",
  "location",
  "source",
]);

export const householdSubjects = pgTable(
  "household_subjects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: householdSubjectKind("kind").notNull(),
    name: text("name").notNull(),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "household_subjects_name_nonempty",
      sql`length(btrim(${table.name})) > 0`,
    ),
    check(
      "household_subjects_details_object",
      sql`jsonb_typeof(${table.details}) = 'object'`,
    ),
  ],
);

export const contextRecords = pgTable(
  "context_records",
  {
    // Producers reuse this ID when retrying the same submission.
    id: uuid("id").primaryKey(),
    kind: contextKind("kind").notNull(),
    topic: text("topic").notNull(),
    summary: text("summary").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    certainty: contextCertainty("certainty").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    scopeEpoch: text("scope_epoch").notNull(),
  },
  (table) => [
    index("context_records_occurred_at_id_idx").on(table.occurredAt, table.id),
    check(
      "context_records_topic_nonempty",
      sql`length(btrim(${table.topic})) > 0`,
    ),
    check(
      "context_records_summary_nonempty",
      sql`length(btrim(${table.summary})) > 0`,
    ),
    check(
      "context_records_scope_epoch_nonempty",
      sql`length(btrim(${table.scopeEpoch})) > 0`,
    ),
    check(
      "context_records_data_object",
      sql`jsonb_typeof(${table.data}) = 'object'`,
    ),
    check(
      "context_records_evidence_array",
      sql`jsonb_typeof(${table.evidence}) = 'array'`,
    ),
    check(
      "context_records_expiry_order",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} >= ${table.occurredAt}`,
    ),
  ],
);

export const contextEntities = pgTable(
  "context_entities",
  {
    contextId: uuid("context_id")
      .notNull()
      .references(() => contextRecords.id, { onDelete: "cascade" }),
    entityType: contextEntityType("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    role: contextEntityRole("role").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.contextId, table.entityType, table.entityId, table.role],
    }),
    index("context_entities_entity_idx").on(
      table.entityType,
      table.entityId,
      table.contextId,
    ),
    check(
      "context_entities_entity_id_nonempty",
      sql`length(btrim(${table.entityId})) > 0`,
    ),
  ],
);
