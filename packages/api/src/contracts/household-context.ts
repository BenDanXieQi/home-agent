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

export const contextBrowseQuerySchema = z
  .object({
    scope_epoch: z.string().min(1).max(100),
    table: contextTableSchema,
    page: z.number().int().min(0).max(10_000),
    search: z.string().max(100),
    context_id: z.uuid().optional(),
    entity: z
      .object({
        type: contextEntityTypeSchema,
        id: z.string().min(1).max(500),
      })
      .optional(),
  })
  .strict();

export const contextBrowseResponseSchema = z.object({
  scope_epoch: z.string(),
  table: contextTableSchema,
  page: z.number().int().nonnegative(),
  page_size: z.number().int().positive(),
  has_more: z.boolean(),
  tables: z.array(
    z.object({
      name: contextTableSchema,
      count: z.number().int().nonnegative(),
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
