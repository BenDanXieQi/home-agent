import { createHash } from "node:crypto";
import { addAbortListener } from "node:events";
import { z } from "zod";
import {
  agentContextPolicy,
  agentHistoryResponseSchema,
  type agentHistoryQuerySchema,
  memberSightingsRetention,
  perceptionWindowsRetention,
} from "@home-agent/api/agent-context";
import { deviceHistoryTimeSchema } from "@home-agent/api/device-history";
import { AppError } from "@home-agent/api/errors";
import { accessHousehold } from "../household/access";
import { HouseholdError } from "../household/errors";
import { jsonBytes } from "../household/config";
import type { HouseholdRuntime } from "../household/runtime";
import {
  memberSightingPositionSchema,
  type createMemberActivityRepository,
} from "../household/identity/activity-repository";
import type { createPerceptionService } from "../perception/service";

const cursorSchema = z.strictObject({
  query: z.string().regex(/^[a-f0-9]{64}$/),
  bindingUpdatedAt: deviceHistoryTimeSchema,
  instanceId: z.uuid().optional(),
  position: z.union([
    memberSightingPositionSchema,
    z.strictObject({ startedAt: z.number(), id: z.uuid() }),
  ]),
});
function decodeCursor(value: string | undefined) {
  if (!value) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
    return cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new AppError("invalid_request");
  }
}

export function createAgentHistoryReader(options: {
  household: HouseholdRuntime;
  sightings: ReturnType<typeof createMemberActivityRepository> | undefined;
  perception: ReturnType<typeof createPerceptionService>;
  shutdown: AbortSignal;
  timeoutMs: number;
}) {
  return async (
    input: Exclude<
      z.infer<typeof agentHistoryQuerySchema>,
      { kind: "device_reports" }
    >,
    requestSignal: AbortSignal,
  ) => {
    const { household, sightings, perception } = options;
    const access = accessHousehold(household, household.epoch);
    if (
      access.identity.accountId !== input.account_id ||
      access.identity.homeId !== input.home_id
    )
      throw new HouseholdError("stale_session");
    if (!sightings) throw new HouseholdError("home_storage");
    const signal = AbortSignal.any([
      requestSignal,
      options.shutdown,
      AbortSignal.timeout(options.timeoutMs),
    ]);
    const abortError = () =>
      new AppError(
        signal.reason instanceof DOMException &&
          signal.reason.name === "TimeoutError"
          ? "agent_timeout"
          : "request_cancelled",
      );
    const assertCurrent = () => {
      if (signal.aborted) throw abortError();
      access.assertCurrent();
    };
    assertCurrent();
    const aborted = Promise.withResolvers<never>();
    const listener = addAbortListener(signal, () => {
      aborted.reject(abortError());
    });
    const run = async () => {
      const { cursor: _cursor, limit: _limit, ...conditions } = input;
      const hash = createHash("sha256")
        .update(JSON.stringify(conditions))
        .digest("hex");
      const cursor = decodeCursor(input.cursor);
      if (cursor && cursor.query !== hash)
        throw new AppError("invalid_request");
      const instanceId = perception.snapshot().instanceId;
      if (
        cursor &&
        (input.kind === "perception_windows"
          ? cursor.instanceId !== instanceId ||
            !("startedAt" in cursor.position)
          : cursor.instanceId !== undefined ||
            !("firstObservedAt" in cursor.position))
      )
        throw new AppError("invalid_request");
      const bindingUpdatedAt = await sightings.binding(
        access.identity,
        assertCurrent,
      );
      assertCurrent();
      if (cursor && cursor.bindingUpdatedAt !== bindingUpdatedAt)
        throw new AppError("invalid_request");
      const candidates =
        input.kind === "member_sightings"
          ? (
              await sightings.history(
                access.identity,
                assertCurrent,
                input,
                cursor && "firstObservedAt" in cursor.position
                  ? { bindingUpdatedAt, position: cursor.position }
                  : undefined,
              )
            ).records
          : perception.history(
              input,
              cursor && "startedAt" in cursor.position
                ? cursor.position
                : undefined,
            );
      const records: Extract<
        z.infer<typeof agentHistoryResponseSchema>,
        { kind: typeof input.kind }
      >["records"][number][] = [];
      let next: string | null = null;
      let more = false;
      const envelope = {
        kind: input.kind,
        account_id: input.account_id,
        home_id: input.home_id,
        start: input.start,
        end: input.end,
        retention:
          input.kind === "member_sightings"
            ? memberSightingsRetention
            : perceptionWindowsRetention,
      };
      const envelopeBytes = jsonBytes({
        ...envelope,
        records: [],
        next_cursor: null,
      });
      let recordBytes = 0;
      const iterator = candidates[Symbol.iterator]();
      try {
        let candidate = iterator.next();
        while (!candidate.done) {
          if (records.length === input.limit) {
            more = true;
            break;
          }
          const record = candidate.value;
          const position =
            "window" in record
              ? { startedAt: record.window.startedAt, id: record.window.id }
              : { firstObservedAt: record.data.firstObservedAt, id: record.id };
          const candidateCursor = Buffer.from(
            JSON.stringify({
              query: hash,
              bindingUpdatedAt,
              ...(input.kind === "perception_windows" ? { instanceId } : {}),
              position,
            }),
          ).toString("base64url");
          candidate = iterator.next();
          const nextCursor = candidate.done ? null : candidateCursor;
          const size = jsonBytes(record) + (records.length ? 1 : 0);
          if (
            envelopeBytes + recordBytes + size + jsonBytes(nextCursor) - 4 >
            agentContextPolicy.historyResponseBytes
          ) {
            if (!records.length) throw new HouseholdError("capacity_exceeded");
            more = true;
            break;
          }
          records.push(record);
          recordBytes += size;
          next = nextCursor;
        }
      } finally {
        iterator.return?.();
      }
      assertCurrent();
      if (
        (await sightings.binding(access.identity, assertCurrent)) !==
        bindingUpdatedAt
      )
        throw new HouseholdError("stale_session");
      assertCurrent();
      return { ...envelope, records, next_cursor: more ? next : null };
    };
    try {
      const result = await Promise.race([run(), aborted.promise]);
      assertCurrent();
      if (result.kind === "perception_windows") {
        for (const record of result.records) {
          if (!("window" in record)) continue;
          const current = perception.window(record.window.id);
          if (!current) throw new HouseholdError("stale_session");
          record.window.inputState = current.inputState;
          record.window.sampledMedia = current.sampledMedia;
        }
      }
      const response = agentHistoryResponseSchema.parse(result);
      if (jsonBytes(response) > agentContextPolicy.historyResponseBytes)
        throw new HouseholdError("capacity_exceeded");
      assertCurrent();
      return response;
    } finally {
      listener[Symbol.dispose]();
    }
  };
}
