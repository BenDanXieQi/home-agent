import type {
  ServiceStatus,
  ServicesStatus,
  ConnectionReasonCode,
  MessageParams,
} from "@home-agent/api/contracts";
import { tracedFetch } from "@home-agent/observability";
import { Hono } from "hono";
import { z } from "zod";
import { requireLocalAccess } from "@home-agent/api/local-access";
import {
  readLimitedJson,
  ResponseBodyError,
} from "@home-agent/api/http/read-body";
import type { ConnectionStore } from "./store";

const MAX_RESPONSE_BYTES = 16_384;
const CHECK_TIMEOUT_MS = 3_000;
const healthResponseSchemas = {
  agent: z.object({
    status: z.literal("ok"),
    service: z.literal("home-agent"),
    runtime: z.literal("bun"),
  }),
  // go2rtc v1.9.14: internal/api/api.go returns internal/app app.Info.
  // Other modules may add fields; do not reject them or pin the version value.
  go2rtc: z.object({
    version: z.string().min(1),
    revision: z.string(),
    host: z.string().min(1),
  }),
};

async function checkServiceConnection(
  serviceName: keyof typeof healthResponseSchemas,
  url: string,
  requestSignal: AbortSignal,
) {
  const timeoutSignal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const completionController = new AbortController();
  const signal = AbortSignal.any([
    requestSignal,
    timeoutSignal,
    completionController.signal,
  ]);
  let status: ServiceStatus["status"] = "unavailable";
  let reasonCode: ConnectionReasonCode = "unreachable";
  let params: MessageParams | undefined;
  try {
    const response = await tracedFetch(
      new URL(serviceName === "agent" ? "/health" : "/api", url),
      { signal, redirect: "error", headers: { Accept: "application/json" } },
    );
    if (!response.ok) {
      reasonCode = "http_error";
      params = { status: response.status };
    } else if (
      !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      reasonCode = "invalid_json";
    } else {
      reasonCode = "invalid_json";
      const responseData = await readLimitedJson(response, MAX_RESPONSE_BYTES);
      reasonCode = "unexpected_response";
      if (healthResponseSchemas[serviceName].safeParse(responseData).success) {
        status = "connected";
        reasonCode = "reachable";
      }
    }
  } catch (error) {
    if (requestSignal.aborted) reasonCode = "cancelled";
    else if (timeoutSignal.aborted) {
      reasonCode = "timeout";
      params = { timeoutMs: CHECK_TIMEOUT_MS };
    } else if (error instanceof ResponseBodyError) {
      reasonCode = error.code;
      if (error.code === "response_too_large")
        params = { maxBytes: MAX_RESPONSE_BYTES };
    }
  } finally {
    completionController.abort();
  }
  return {
    url,
    status,
    checkedAt: new Date().toISOString(),
    reasonCode,
    ...(params ? { params } : {}),
  } satisfies ServiceStatus;
}

export function createConnectionStatusRoutes(
  port: number,
  connectionStore: Pick<ConnectionStore, "read">,
) {
  return new Hono()
    .use(requireLocalAccess([port, 5173]))
    .get("/status", async (c) => {
      const { services } = await connectionStore.read();
      const [agent, go2rtc] = await Promise.all([
        checkServiceConnection("agent", services.agent.url, c.req.raw.signal),
        checkServiceConnection("go2rtc", services.go2rtc.url, c.req.raw.signal),
      ]);
      return c.json({ services: { agent, go2rtc } } satisfies ServicesStatus);
    });
}
