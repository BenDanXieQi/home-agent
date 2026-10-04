import { z } from "zod";

export const contextEntityTypeSchema = z.enum([
  "person",
  "pet",
  "room",
  "device",
]);

export const contextTableSchema = z.enum([
  "household_subjects",
  "context_records",
  "context_entities",
]);

export const contextEntityRoleSchema = z.enum([
  "subject",
  "participant",
  "location",
  "source",
]);
export const contextCursorSchema = z.discriminatedUnion("table", [
  z.object({
    table: z.literal("household_subjects"),
    id: z.uuid(),
    created_at: z.iso.datetime({ precision: 6 }),
  }),
  z.object({
    table: z.literal("context_records"),
    id: z.uuid(),
    occurred_at: z.iso.datetime({ precision: 6 }),
  }),
  z.object({
    table: z.literal("context_entities"),
    context_id: z.uuid(),
    entity_type: contextEntityTypeSchema,
    entity_id: z.string().min(1).max(500),
    role: contextEntityRoleSchema,
  }),
]);

export const contextBrowseQuerySchema = z
  .object({
    scope_epoch: z.string().min(1).max(100),
    table: contextTableSchema,
    cursor: contextCursorSchema.nullable(),
    search: z.string().max(100),
    context_id: z.uuid().optional(),
    entity: z
      .object({
        type: contextEntityTypeSchema,
        id: z.string().min(1).max(500),
      })
      .optional(),
  })
  .strict()
  .refine(
    (input) => input.cursor === null || input.cursor.table === input.table,
    "Cursor must belong to the selected table",
  );

export const contextBrowseResponseSchema = z.object({
  scope_epoch: z.string(),
  table: contextTableSchema,
  page_size: z.number().int().positive(),
  has_more: z.boolean(),
  next_cursor: contextCursorSchema.nullable(),
  tables: z.array(
    z.object({
      name: contextTableSchema,
      count: z.number().int().nonnegative(),
      count_is_estimate: z.boolean(),
      columns: z.array(
        z.object({
          key: z.string(),
          name: z.string(),
          type: z.string(),
          nullable: z.boolean(),
          primary: z.boolean(),
        }),
      ),
    }),
  ),
  rows: z.array(z.record(z.string(), z.json())),
});
