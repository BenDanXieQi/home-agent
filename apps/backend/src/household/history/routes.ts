import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { AppError, errorPayload } from "@home-agent/api/errors";
import {
  errorResponse,
  handleHttpError,
  validateJson,
} from "@home-agent/api/errors/hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import {
  deviceHistoryPolicy,
  deviceHistoryStreamPolicy,
  deviceHistoryStreamRequestSchema,
} from "@home-agent/api/device-history";
import { createSseTransport } from "../../http/sse-transport";
import { accessHousehold } from "../access";
import { HouseholdError } from "../errors";
import type { HouseholdRuntime } from "../runtime";
import { householdHttpError } from "../http-errors";
import type { createDeviceHistoryQuery } from "./query";
import { createDeviceHistoryReader } from "./read";
import type { createDeviceHistoryService } from "./service";
import { createDeviceHistoryLiveReader } from "./live";
import { deliverDeviceHistory } from "./stream";

export function createDeviceHistoryRoutes(
  port: number,
  household: HouseholdRuntime,
  query: ReturnType<typeof createDeviceHistoryQuery> | undefined,
  history:
    | Pick<
        ReturnType<typeof createDeviceHistoryService>,
        "subscribe" | "revision"
      >
    | undefined,
  shutdown: AbortSignal,
  timeoutMs: number,
) {
  const read = createDeviceHistoryReader(household, query, shutdown, timeoutMs);
  const liveRead = createDeviceHistoryLiveReader(read, history);
  let connections = 0;
  const app = new Hono();
  app.use(requireLocalAccess([port, 5173], { webEntry: true }));
  app.use(
    bodyLimit({
      maxSize: deviceHistoryPolicy.requestBytes,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
  );
  app.onError((error, c) =>
    handleHttpError(
      error instanceof HouseholdError ? householdHttpError(error) : error,
      c,
    ),
  );
  return app
    .on("HEAD", "/events", (c) =>
      c.body(null, 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      }),
    )
    .post("/events", validateJson(deviceHistoryStreamRequestSchema), (c) => {
      c.header("Cache-Control", "no-store");
      c.header("X-Accel-Buffering", "no");
      if (
        shutdown.aborted ||
        connections >= deviceHistoryStreamPolicy.connections
      )
        throw new HouseholdError("capacity_exceeded");
      const input = c.req.valid("json");
      if (input.delivery === "live" && Date.parse(input.start) >= Date.now())
        throw new AppError("invalid_request");
      const access = accessHousehold(household, household.epoch);
      if (
        access.identity.accountId !== input.account_id ||
        access.identity.homeId !== input.home_id
      )
        throw new HouseholdError("stale_session");
      connections++;
      const response = streamSSE(c, async (stream) => {
        const scope = new AbortController();
        const signal = AbortSignal.any([
          c.req.raw.signal,
          shutdown,
          scope.signal,
        ]);
        const transport = createSseTransport(stream, {
          signal,
          ...deviceHistoryStreamPolicy,
          heartbeat: {
            intervalMs: deviceHistoryStreamPolicy.heartbeatMs,
            message: () => ({ event: "heartbeat", data: "{}" }),
          },
        });
        const assertCurrent = () => {
          transport.signal.throwIfAborted();
          access.assertCurrent();
        };
        const unsubscribe = household.subscribe(() => {
          try {
            access.assertCurrent();
          } catch (error) {
            scope.abort(error);
          }
        });
        try {
          assertCurrent();
          await deliverDeviceHistory({
            input,
            liveRead,
            scope: household.epoch,
            read,
            history,
            signal: transport.signal,
            assertCurrent,
            send: (event) => {
              assertCurrent();
              return transport.send({
                event: event.event,
                data: JSON.stringify(event.data),
              });
            },
          });
        } catch (error) {
          if (!transport.signal.aborted) {
            const failure =
              error instanceof HouseholdError
                ? householdHttpError(error)
                : error instanceof AppError
                  ? error
                  : new AppError("internal_error");
            await transport.send({
              event: "error",
              data: JSON.stringify(errorPayload(failure)),
            });
          }
        } finally {
          unsubscribe();
          transport.close();
          connections--;
        }
      });
      response.headers.set("Cache-Control", "no-store");
      return response;
    });
}
