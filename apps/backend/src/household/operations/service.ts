import { entityKey } from "@home-agent/api/household";
import {
  provenancePolicy,
  commandSourceSchema,
  commandRecordSchema,
  type commandTargetSchema,
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
  function recordCommand(record: ReturnType<typeof commandRecordSchema.parse>) {
    if (jsonBytes(record) > provenancePolicy.recordBytes) {
      record = {
        ...record,
        response: null,
        output: null,
        message: null,
        error: null,
        completeness: "omitted",
      };
    }
    const size = jsonBytes(record);
    if (size > provenancePolicy.recordBytes) {
      diagnostics.dropped++;
      return;
    }
    const submission = structuredClone(record);
    writer
      .submit(submission, () => repository.recordCommand(submission))
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
  function recordBestEffort(record: Parameters<typeof recordCommand>[0]) {
    try {
      recordCommand(record);
    } catch {
      diagnostics.failed++;
      console.warn("Device command snapshot could not be recorded");
    }
  }

  async function execute(
    scope: Scope,
    source: Source,
    target: ReturnType<typeof commandTargetSchema.parse>,
    parentRequestId: string,
    id: string,
    signal: AbortSignal,
    assertCurrent: () => void,
  ) {
    const capturedSource = commandSourceSchema.parse(source);
    const calledAt = new Date();
    const device =
      scope.snapshot.projection.device[
        entityKey(scope.identity.accountId, target.device_id)
      ];
    const base = {
      id,
      parent_request_id: parentRequestId,
      account_id: scope.identity.accountId,
      home_id: scope.identity.homeId,
      source: capturedSource,
      device_snapshot: {
        name: device?.name ?? null,
        model: device?.model ?? null,
        specification: device?.spec_id ?? null,
        room_id: device?.room_id ?? null,
      },
      endpoint: control.endpoint(target),
      target: structuredClone(target),
      called_at: calledAt.toISOString(),
      expires_at: new Date(
        calledAt.getTime() + retentionDays * 86400_000,
      ).toISOString(),
      completeness: "received_fields" as const,
    };
    try {
      const result = await control.dispatch(base.target, signal, assertCurrent);
      recordBestEffort({
        ...base,
        sent_at: result.sent_at,
        received_at: result.received_at,
        outcome: result.outcome,
        response_matches: result.response_matches,
        completeness: result.completeness,
        provider_code: result.provider_code,
        message: result.message,
        output: result.output,
        response: result.response,
        error: result.error,
      });
      const status =
        result.outcome === "provider_succeeded" || result.outcome === "pending"
          ? ("accepted" as const)
          : result.outcome === "rejected"
            ? ("rejected" as const)
            : ("unknown" as const);
      return { command_id: id, result: { ...result, status } };
    } catch (error) {
      recordBestEffort({
        ...base,
        sent_at: null,
        received_at: null,
        outcome: "preflight_failed",
        response_matches: 0,
        provider_code: null,
        message: null,
        output: null,
        response: null,
        error: control.failure(error),
      });
      throw error;
    }
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
      parentRequestId: string,
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
        parentRequestId,
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
      parentRequestId: string,
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
        parentRequestId,
        commandId,
        signal,
        assertCurrent,
      );
    },
    diagnostics: () => ({ ...diagnostics }),
  };
}
