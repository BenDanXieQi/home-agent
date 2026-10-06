import { queryOptions } from "@tanstack/react-query";
import {
  sameSpatialScope,
  spaceSchema,
  passageSchema,
  observationBindingSchema,
  spatialSnapshotSchema,
  spatialDeleteResultSchema,
  type spaceSaveSchema,
  type passageSaveSchema,
  type observationBindingSaveSchema,
  type observationBindingEnabledSchema,
  type spatialDeleteSchema,
} from "@home-agent/api/spatial";
import { requestJson } from "../../api/client";

export function spatialQueryOptions(scope: string) {
  return queryOptions({
    queryKey: ["spatial", scope],
    queryFn: ({ signal }) =>
      requestJson(
        (api, options) => api.api.spatial.read.$post({ json: {} }, options),
        spatialSnapshotSchema,
        { signal },
      ),
    retry: false,
    gcTime: 0,
  });
}
export type SpatialSnapshot = ReturnType<typeof spatialSnapshotSchema.parse>;
export type SpatialSaveCommand =
  | { resource: "space"; input: ReturnType<typeof spaceSaveSchema.parse> }
  | { resource: "passage"; input: ReturnType<typeof passageSaveSchema.parse> }
  | {
      resource: "binding";
      input: ReturnType<typeof observationBindingSaveSchema.parse>;
    };
export type SpatialCommand =
  | ({ action: "save" } & SpatialSaveCommand)
  | {
      action: "enabled";
      resource: "binding";
      input: ReturnType<typeof observationBindingEnabledSchema.parse>;
    }
  | {
      action: "delete";
      resource: SpatialSaveCommand["resource"];
      input: ReturnType<typeof spatialDeleteSchema.parse>;
    };

export async function executeSpatialCommand(command: SpatialCommand) {
  if (command.action === "delete") {
    return requestJson(
      (api, options) => {
        switch (command.resource) {
          case "space":
            return api.api.spatial.spaces.delete.$post(
              { json: command.input },
              options,
            );
          case "passage":
            return api.api.spatial.passages.delete.$post(
              { json: command.input },
              options,
            );
          case "binding":
            return api.api.spatial["observation-bindings"].delete.$post(
              { json: command.input },
              options,
            );
          default:
            throw new Error("Unsupported spatial resource");
        }
      },
      spatialDeleteResultSchema,
      { acceptedStatuses: [409] },
    );
  }
  if (command.action === "enabled") {
    const record = await requestJson(
      (api, options) =>
        api.api.spatial["observation-bindings"].enabled.$post(
          { json: command.input },
          options,
        ),
      observationBindingSchema,
    );
    return { status: "saved" as const, resource: "binding" as const, record };
  }
  switch (command.resource) {
    case "space":
      return {
        status: "saved" as const,
        resource: "space" as const,
        record: await requestJson(
          (api, options) =>
            api.api.spatial.spaces.save.$post({ json: command.input }, options),
          spaceSchema,
        ),
      };
    case "passage":
      return {
        status: "saved" as const,
        resource: "passage" as const,
        record: await requestJson(
          (api, options) =>
            api.api.spatial.passages.save.$post(
              { json: command.input },
              options,
            ),
          passageSchema,
        ),
      };
    case "binding":
      return {
        status: "saved" as const,
        resource: "binding" as const,
        record: await requestJson(
          (api, options) =>
            api.api.spatial["observation-bindings"].save.$post(
              { json: command.input },
              options,
            ),
          observationBindingSchema,
        ),
      };
    default:
      throw new Error("Unsupported spatial resource");
  }
}

/** Compare actual persisted values after a response was lost; never replay a write. */
export function confirmSpatialCommand(
  command: SpatialCommand,
  snapshot: SpatialSnapshot,
) {
  if (!sameSpatialScope(command.input.scope, snapshot.scope))
    return "scope-changed" as const;
  const records =
    command.resource === "space"
      ? snapshot.spaces
      : command.resource === "passage"
        ? snapshot.passages
        : snapshot.observation_bindings;
  const actual = records.find((record) => record.id === command.input.id);
  if (command.action === "delete") {
    if (!actual) return "confirmed" as const;
  } else if (actual) {
    const fields =
      command.action === "enabled"
        ? { enabled: command.input.enabled }
        : Object.fromEntries(
            Object.entries(command.input).filter(
              ([key]) =>
                !["scope", "operation", "expected_updated_at"].includes(key),
            ),
          );
    const values = new Map(Object.entries(actual));
    if (
      Object.entries(fields).every(([key, value]) => values.get(key) === value)
    )
      return "confirmed" as const;
  }
  if (command.action === "save" && command.input.operation === "create")
    return actual ? ("changed" as const) : ("not-applied" as const);
  return "expected_updated_at" in command.input &&
    actual?.updated_at === command.input.expected_updated_at
    ? ("not-applied" as const)
    : ("changed" as const);
}
