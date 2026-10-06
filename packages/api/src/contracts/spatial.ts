import { z } from "zod";
import { inventoryDeviceSchema } from "../domain/devices";

const timestamps = {
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
};
export const spatialScopeSchema = z
  .object({
    account_id: z.string().min(1),
    home_id: z.string().min(1),
    updated_at: z.iso.datetime(),
  })
  .strict()
  .nullable();
export function sameSpatialScope(
  left: z.infer<typeof spatialScopeSchema>,
  right: z.infer<typeof spatialScopeSchema>,
) {
  return (
    left?.account_id === right?.account_id &&
    left?.home_id === right?.home_id &&
    left?.updated_at === right?.updated_at
  );
}
const scope = { scope: spatialScopeSchema };
const spaceFields = {
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000),
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
    saveOperation.options[0].extend({ ...fields, ...scope }).strict(),
    saveOperation.options[1].extend({ ...fields, ...scope }).strict(),
  ]);
}
export const spaceSaveSchema = saveCommand(spaceFields);
export const spaceSchema = z.object({ ...spaceFields, ...timestamps }).strict();
const passageFields = {
  ...spaceFields,
  space_a_id: z.uuid(),
  space_b_id: z.uuid(),
};
const passageRecordSchema = z
  .object({ ...passageFields, ...timestamps })
  .strict();
const differentEndpoints = (
  value: Pick<z.infer<typeof passageRecordSchema>, "space_a_id" | "space_b_id">,
) => value.space_a_id !== value.space_b_id;
export const passageSaveSchema = saveCommand(passageFields).refine(
  differentEndpoints,
  {
    path: ["space_b_id"],
    message: "Passage endpoints must differ.",
  },
);
export const passageSchema = passageRecordSchema.refine(differentEndpoints);
const bindingFields = {
  id: z.uuid(),
  device_id: inventoryDeviceSchema.shape.id.min(1).max(512),
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
    ...scope,
    id: z.uuid(),
    enabled: z.boolean(),
    expected_updated_at: timestamps.updated_at,
  })
  .strict();
export const spatialSnapshotSchema = z.object({
  ...scope,
  spaces: z.array(spaceSchema),
  passages: z.array(passageSchema),
  observation_bindings: z.array(observationBindingSchema),
});
export const spatialDeleteSchema = z
  .object({
    ...scope,
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
