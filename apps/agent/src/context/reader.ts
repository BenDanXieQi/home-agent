import { z } from "zod";
import type { ContextSource } from "./source";
import {
  agentContextPolicy,
  agentHistoryQuerySchema,
  agentHistoryResponseSchema,
  agentMaterialQuerySchema,
  agentMaterialResponseSchema,
} from "@home-agent/api/agent-context";
import { AppError } from "@home-agent/api/errors";
import { requestJson } from "@home-agent/api/http/request-json";
import type { createContextReceiver } from "./receiver";

export function createContextReader(options: {
  client: Pick<ContextSource, "history" | "material">;
  receiver: Pick<
    ReturnType<typeof createContextReceiver>,
    "currentSignal" | "householdPart"
  >;
}) {
  const client = options.client;
  async function readCurrent<T>(
    requestSignal: AbortSignal,
    read: (signal: AbortSignal) => Promise<T>,
  ) {
    const currentSignal = options.receiver.currentSignal();
    if (!currentSignal) throw new AppError("household_unavailable");
    const signal = AbortSignal.any([requestSignal, currentSignal]);
    signal.throwIfAborted();
    const result = await read(signal);
    signal.throwIfAborted();
    return result;
  }

  const policy = {
    timeoutMs: agentContextPolicy.historyTimeoutMs,
    maxBytes: agentContextPolicy.historyResponseBytes,
    unavailableCode: "household_unavailable" as const,
  };
  return {
    readRooms(requestSignal: AbortSignal) {
      return readCurrent(requestSignal, async () => {
        const household = options.receiver.householdPart();
        if (household?.status !== "ready")
          throw new AppError("household_unavailable");

        return Object.values(household.data.room)
          .filter((room) => !room.archived)
          .map(({ room_id, name }) => ({ room_id, name }));
      });
    },
    readHistory(
      query: z.input<typeof agentHistoryQuerySchema>,
      requestSignal: AbortSignal,
    ) {
      return readCurrent(requestSignal, async (signal) => {
        const input = agentHistoryQuerySchema.parse(query);
        const result = await requestJson(
          (transportSignal) => client.history(input, transportSignal),
          agentHistoryResponseSchema,
          { ...policy, signal },
        );
        if (
          result.kind !== input.kind ||
          result.start !== input.start ||
          result.end !== input.end
        )
          throw new AppError("household_unavailable");
        return result;
      });
    },
    readMaterial(
      reference: z.input<typeof agentMaterialQuerySchema>,
      requestSignal: AbortSignal,
    ) {
      return readCurrent(requestSignal, async (signal) => {
        const input = agentMaterialQuerySchema.parse(reference);
        const result = await requestJson(
          (transportSignal) => client.material(input, transportSignal),
          agentMaterialResponseSchema,
          { ...policy, signal },
        );
        if (
          result.kind !== input.kind ||
          (result.kind === "member_sighting"
            ? result.record.id
            : result.window.id) !== input.id
        )
          throw new AppError("household_unavailable");
        return result;
      });
    },
  };
}
