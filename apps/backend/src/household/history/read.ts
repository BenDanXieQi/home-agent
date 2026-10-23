import pTimeout from "p-timeout";
import { AppError } from "@home-agent/api/errors";
import type { deviceHistoryQuerySchema } from "@home-agent/api/device-history";
import { jsonBytes } from "../config";
import { accessHousehold } from "../access";
import { HouseholdError } from "../errors";
import type { HouseholdRuntime } from "../runtime";
import type { createDeviceHistoryQuery } from "./query";

export function createDeviceHistoryReader(
  household: HouseholdRuntime,
  query: ReturnType<typeof createDeviceHistoryQuery> | undefined,
  shutdown: AbortSignal,
  timeoutMs: number,
) {
  async function withinRequest<T>(
    requestSignal: AbortSignal,
    run: (
      operation: NonNullable<typeof query>,
      context: Parameters<NonNullable<typeof query>>[0],
    ) => Promise<T>,
  ) {
    const access = accessHousehold(household, household.epoch);
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
    try {
      const result = await pTimeout(
        Promise.resolve().then(() =>
          run(query, {
            identity: access.identity,
            assertCurrent,
            signal,
            timeoutMs,
          }),
        ),
        { milliseconds: Infinity, signal },
      );
      assertCurrent();
      return result;
    } catch (cause) {
      if (signal.aborted) throw abortError();
      throw cause;
    }
  }
  const read = (
    input: ReturnType<typeof deviceHistoryQuerySchema.parse>,
    requestSignal: AbortSignal,
    transportBytes: Parameters<ReturnType<typeof createDeviceHistoryQuery>>[2],
  ) => {
    return withinRequest(requestSignal, (operation, context) =>
      operation(context, input, transportBytes),
    );
  };
  return Object.assign(read, {
    export(
      input: Parameters<typeof read>[0],
      requestSignal: AbortSignal,
      receive: Parameters<NonNullable<typeof query>["export"]>[3],
    ) {
      return withinRequest(requestSignal, (operation, context) =>
        operation.export(context, input, jsonBytes, receive),
      );
    },
  });
}
