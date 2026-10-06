import { addAbortListener } from "node:events";
import { AppError } from "@home-agent/api/errors";
import type { deviceHistoryQuerySchema } from "@home-agent/api/device-history";
import { jsonBytes } from "../config";
import { accessHousehold } from "../access";
import { HouseholdError } from "../errors";
import type { HouseholdRuntime } from "../runtime";
import type { createDeviceHistoryQuery } from "./query";

/** Capture one binding and keep every history page within its request lifetime. */
export function createDeviceHistoryReader(
  household: HouseholdRuntime,
  query: ReturnType<typeof createDeviceHistoryQuery> | undefined,
  shutdown: AbortSignal,
  timeoutMs: number,
) {
  async function withinRequest<T>(
    input: ReturnType<typeof deviceHistoryQuerySchema.parse>,
    requestSignal: AbortSignal,
    run: (
      operation: NonNullable<typeof query>,
      context: Parameters<NonNullable<typeof query>>[0],
    ) => Promise<T>,
  ) {
    const access = accessHousehold(household, household.epoch);
    if (
      access.identity.accountId !== input.account_id ||
      access.identity.homeId !== input.home_id
    )
      throw new HouseholdError("stale_session");
    if (!query) throw new HouseholdError("home_storage");
    const signal = AbortSignal.any([
      requestSignal,
      shutdown,
      AbortSignal.timeout(timeoutMs),
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
    const listener = addAbortListener(signal, () =>
      aborted.reject(abortError()),
    );
    try {
      const result = await Promise.race([
        run(query, {
          identity: access.identity,
          assertCurrent,
          signal,
          timeoutMs,
        }),
        aborted.promise,
      ]);
      assertCurrent();
      return result;
    } finally {
      listener[Symbol.dispose]();
    }
  }
  const read = (
    input: ReturnType<typeof deviceHistoryQuerySchema.parse>,
    requestSignal: AbortSignal,
    transportBytes: Parameters<ReturnType<typeof createDeviceHistoryQuery>>[2],
  ) => {
    return withinRequest(input, requestSignal, (operation, context) =>
      operation(context, input, transportBytes),
    );
  };
  return Object.assign(read, {
    export(
      input: Parameters<typeof read>[0],
      requestSignal: AbortSignal,
      receive: Parameters<NonNullable<typeof query>["export"]>[3],
    ) {
      return withinRequest(input, requestSignal, (operation, context) =>
        operation.export(context, input, jsonBytes, receive),
      );
    },
  });
}
