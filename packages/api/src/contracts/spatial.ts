import { z } from "zod";
import { inventoryDeviceSchema } from "../domain/devices";

const timestamps = {
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
};
const spaceFields = {
  id: z.uuid(),
  name: z.string().trim().min(1),
  description: z.string(),
};
const saveOperation = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create") }),
  z.object({
    operation: z.literal("update"),
    expected_updated_at: timestamps.updated_at,
  }),
]);
export type SpatialSaveOperation = z.infer<typeof saveOperation>;
function saveCommand<T extends z.ZodRawShape>(fields: T) {
  return z.discriminatedUnion("operation", [
    saveOperation.options[0].extend(fields).strict(),
    saveOperation.options[1].extend(fields).strict(),
  ]);
}
export const spaceSaveSchema = saveCommand(spaceFields);
export const spaceDefinitionSchema = z.strictObject(spaceFields);
export const spaceSchema = spaceDefinitionSchema.extend(timestamps);
const passageFields = {
  ...spaceFields,
  space_a_id: z.uuid(),
  space_b_id: z.uuid(),
};
const passageFieldsSchema = z.strictObject(passageFields);
const differentEndpoints = (
  value: Pick<z.infer<typeof passageFieldsSchema>, "space_a_id" | "space_b_id">,
) => value.space_a_id !== value.space_b_id;
export const passageSaveSchema = saveCommand(passageFields).refine(
  differentEndpoints,
  {
    path: ["space_b_id"],
    message: "Passage endpoints must differ.",
  },
);
export const passageDefinitionSchema =
  passageFieldsSchema.refine(differentEndpoints);
export const passageSchema = passageDefinitionSchema.safeExtend(timestamps);
export const spatialLayoutSchema = z
  .strictObject({
    spaces: z.array(spaceDefinitionSchema),
    passages: z.array(passageDefinitionSchema),
  })
  .superRefine((layout, ctx) => {
    const spaces = new Set(layout.spaces.map((space) => space.id));
    const passages = new Set(layout.passages.map((passage) => passage.id));
    if (
      spaces.size !== layout.spaces.length ||
      passages.size !== layout.passages.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Layout record IDs must be unique.",
      });
    layout.passages.forEach((passage, index) => {
      for (const endpoint of ["space_a_id", "space_b_id"] as const) {
        if (!spaces.has(passage[endpoint]))
          ctx.addIssue({
            code: "custom",
            path: ["passages", index, endpoint],
            message: "Passage endpoints must refer to layout spaces.",
          });
      }
    });
  });
const recordVersion = z.strictObject({
  id: z.uuid(),
  updated_at: timestamps.updated_at,
});
export const spatialLayoutApplySchema = spatialLayoutSchema.safeExtend({
  expected: z.strictObject({
    spaces: z.array(recordVersion),
    passages: z.array(recordVersion),
  }),
});
const bindingFields = {
  id: z.uuid(),
  device_id: inventoryDeviceSchema.shape.id.min(1),
  channel: inventoryDeviceSchema.shape.channels.element.nullable(),
  space_id: z.uuid().nullable(),
  passage_id: z.uuid().nullable(),
  description: spaceSchema.shape.description,
  enabled: z.boolean(),
};
const bindingRecordSchema = z
  .object({ ...bindingFields, ...timestamps })
  .strict();
const oneTarget = (
  value: Pick<z.infer<typeof bindingRecordSchema>, "space_id" | "passage_id">,
) => (value.space_id === null) !== (value.passage_id === null);
export const observationBindingSaveSchema = saveCommand(bindingFields).refine(
  oneTarget,
  {
    path: ["space_id"],
    message: "Select exactly one observation target.",
  },
);
export const observationBindingSchema = bindingRecordSchema.refine(oneTarget);
export const observationBindingEnabledSchema = z
  .object({
    id: z.uuid(),
    enabled: z.boolean(),
    expected_updated_at: timestamps.updated_at,
  })
  .strict();
export const spatialSnapshotSchema = z.object({
  spaces: z.array(spaceSchema),
  passages: z.array(passageSchema),
  observation_bindings: z.array(observationBindingSchema),
});
export const spatialDeleteSchema = z
  .object({
    id: z.uuid(),
    expected_updated_at: timestamps.updated_at,
  })
  .strict();
export const spatialReadSchema = z.object({}).strict();
export const spatialDeleteResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("deleted"), id: z.uuid() }),
  z.object({
    status: z.literal("referenced"),
    id: z.uuid(),
    references: spatialSnapshotSchema
      .pick({ passages: true, observation_bindings: true })
      .refine(
        (value) =>
          value.passages.length + value.observation_bindings.length > 0,
      ),
  }),
]);
