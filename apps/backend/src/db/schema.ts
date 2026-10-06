import type { z } from "zod";
import type { referenceInputSchema } from "../household/identity/contracts";
import { sql } from "drizzle-orm";
import {
  contextEntityTypeSchema,
  contextEntityRoleSchema,
} from "@home-agent/api/household-context";
import {
  boolean,
  integer,
  unique,
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

export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("spaces_name_nonempty", sql`length(btrim(${table.name})) > 0`),
  ],
);

export const passages = pgTable(
  "passages",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    spaceAId: uuid("space_a_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "restrict" }),
    spaceBId: uuid("space_b_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "restrict" }),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("passages_name_nonempty", sql`length(btrim(${table.name})) > 0`),
    check(
      "passages_endpoints_differ",
      sql`${table.spaceAId} <> ${table.spaceBId}`,
    ),
    index("passages_space_a_idx").on(table.spaceAId),
    index("passages_space_b_idx").on(table.spaceBId),
  ],
);

export const observationBindings = pgTable(
  "observation_bindings",
  {
    id: uuid("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    channel: integer("channel"),
    spaceId: uuid("space_id").references(() => spaces.id, {
      onDelete: "restrict",
    }),
    passageId: uuid("passage_id").references(() => passages.id, {
      onDelete: "restrict",
    }),
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "observation_bindings_one_target",
      sql`(${table.spaceId} is null) <> (${table.passageId} is null)`,
    ),
    check(
      "observation_bindings_device_nonempty",
      sql`length(btrim(${table.deviceId})) > 0`,
    ),
    check(
      "observation_bindings_channel",
      sql`${table.channel} is null or ${table.channel} in (1, 2)`,
    ),
    index("observation_bindings_space_idx").on(table.spaceId),
    index("observation_bindings_passage_idx").on(table.passageId),
  ],
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
export const contextEntityRole = pgEnum(
  "context_entity_role",
  contextEntityRoleSchema.enum,
);

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

export const identityMembers = pgTable("identity_members", {
  memberId: uuid("member_id")
    .primaryKey()
    .references(() => householdSubjects.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
});

export const identitySamples = pgTable(
  "identity_samples",
  {
    id: uuid("id").primaryKey(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => identityMembers.memberId, { onDelete: "cascade" }),
    imageKey: uuid("image_key").notNull().unique(),
    imageBytes: integer("image_bytes").notNull(),
    contentType: text("content_type").notNull(),
    sha256: text("sha256").notNull(),
    source: jsonb("source")
      .$type<z.infer<typeof referenceInputSchema>["source"]>()
      .notNull(),
    quality: jsonb("quality")
      .$type<z.infer<typeof referenceInputSchema>["quality"]>()
      .notNull(),
    modelVersion: text("model_version").notNull(),
    processingVersion: text("processing_version").notNull(),
    feature: jsonb("feature")
      .$type<z.infer<typeof referenceInputSchema>["feature"]>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("identity_samples_member_idx").on(table.memberId),
    unique("identity_samples_member_sha256_unique").on(
      table.memberId,
      table.sha256,
    ),
    check("identity_samples_bytes_positive", sql`${table.imageBytes} > 0`),
  ],
);
