import { freeze } from "@home-agent/api/immutable";
import {
  provenancePolicy,
  commandSourceSchema,
  commandRecordSchema,
  commandTargetSchema,
  deviceControlResultSchema,
} from "@home-agent/api/action-provenance";
import type { DeviceControl } from "./control";
import type { createRecordWriter } from "../records/writer";
import type { createCommandRepository } from "./repository";
import type { accessHousehold } from "../access";
import { jsonBytes } from "../config";

type Source = ReturnType<typeof commandSourceSchema.parse>;
type Scope = ReturnType<typeof accessHousehold>;
export function createDeviceOperations(
  control: DeviceControl,
  repository: ReturnType<typeof createCommandRepository>,
  writer: ReturnType<typeof createRecordWriter>,
  retentionDays: number,
) {
  const diagnostics = { saved: 0, failed: 0, dropped: 0 };
  function recordCommand(
    scope: Scope,
    record: ReturnType<typeof commandRecordSchema.parse>,
  ) {
    const size = jsonBytes(record);
    if (size > provenancePolicy.recordBytes) {
      diagnostics.dropped++;
      return;
    }
    const submission = structuredClone(record);
    writer
      .submit(submission, () => repository.recordCommand(scope, submission))
      .then(() => {
        diagnostics.saved++;
      })
      .catch(() => {
        diagnostics.failed++;
        console.warn(
          "Device command record not saved; control will not be retried",
        );
      });
  }
  function recordBestEffort(
    scope: Scope,
    record: Parameters<typeof recordCommand>[1],
  ) {
    try {
      recordCommand(scope, record);
    } catch {
      diagnostics.failed++;
      console.warn("Device command snapshot could not be recorded");
    }
  }

  async function execute(
    scope: Scope,
    source: Source,
    target: ReturnType<typeof commandTargetSchema.parse>,
    id: string,
    signal: AbortSignal,
    assertCurrent: () => void,
  ) {
    const calledAt = new Date();
    const base = freeze({
      id,
      source: commandSourceSchema.parse(source),
      target: commandTargetSchema.parse(target),
      called_at: calledAt.toISOString(),
      expires_at: new Date(
        calledAt.getTime() + retentionDays * 86400_000,
      ).toISOString(),
    });
    const sending: { at: string | null } = { at: null };
    let result;
    try {
      result = deviceControlResultSchema.parse(
        await control.dispatch(base.target, signal, assertCurrent, (at) => {
          sending.at ??= at;
        }),
      );
    } catch (error) {
      if (sending.at === null) {
        recordBestEffort(scope, { ...base, sent_at: null });
        throw error;
      }
      result = deviceControlResultSchema.parse({
        sent_at: sending.at,
        received_at: new Date().toISOString(),
        outcome: "unknown",
        response_matches: 0,
        completeness: "omitted",
        provider_code: null,
        message: null,
        output: null,
        response: null,
        error: { message: "Control response unavailable after sending began" },
      });
    }
    recordBestEffort(scope, { ...base, sent_at: sending.at });
    const status =
      result.outcome === "provider_succeeded" || result.outcome === "pending"
        ? ("accepted" as const)
        : result.outcome === "rejected"
          ? ("rejected" as const)
          : ("unknown" as const);
    return { command_id: id, result: { ...result, status } };
  }
  return {
    executePropertyWrite(
      scope: Scope,
      source: Source,
      request: Omit<
        Extract<
          ReturnType<typeof commandTargetSchema.parse>,
          { kind: "property" }
        >,
        "kind"
      >,
      signal: AbortSignal,
      assertCurrent: () => void,
      commandId: string = crypto.randomUUID(),
    ) {
      return execute(
        scope,
        source,
        {
          kind: "property",
          device_id: request.device_id,
          siid: request.siid,
          piid: request.piid,
          value: request.value,
        },
        commandId,
        signal,
        assertCurrent,
      );
    },
    executeDeviceAction(
      scope: Scope,
      source: Source,
      request: Omit<
        Extract<
          ReturnType<typeof commandTargetSchema.parse>,
          { kind: "action" }
        >,
        "kind"
      >,
      signal: AbortSignal,
      assertCurrent: () => void,
      commandId: string = crypto.randomUUID(),
    ) {
      return execute(
        scope,
        source,
        {
          kind: "action",
          device_id: request.device_id,
          siid: request.siid,
          aiid: request.aiid,
          inputs: request.inputs,
        },
        commandId,
        signal,
        assertCurrent,
      );
    },
    diagnostics: () => ({ ...diagnostics }),
  };
}
