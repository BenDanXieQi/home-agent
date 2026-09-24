import type {
  ServiceStatus,
  ServicesStatus,
  ConnectionReasonCode,
  MessageParams,
} from "@home-agent/api/contracts";
import { tracedFetch } from "@home-agent/observability";
import { Hono } from "hono";
import { z } from "zod";
import type { Environment } from "../environment";
import type { AppContext } from "../app-context";
import { requireLocalManagementAccess } from "../middleware/local-management";
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
): Promise<ServiceStatus> {
  const timeoutSignal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const completionController = new AbortController();
  const signal = AbortSignal.any([
    requestSignal,
    timeoutSignal,
    completionController.signal,
  ]);
  let reader:
    | Pick<
        ReadableStreamDefaultReader<Uint8Array>,
        "read" | "cancel" | "releaseLock"
      >
    | undefined;
  let status: ServiceStatus["status"] = "unavailable";
  let reasonCode: ConnectionReasonCode = "unreachable";
  let params: MessageParams | undefined;
  try {
    const response = await tracedFetch(
      new URL(serviceName === "agent" ? "/health" : "/api", url),
      { signal, redirect: "error", headers: { Accept: "application/json" } },
    );
    reader = response.body?.getReader();
    if (!response.ok) {
      reasonCode = "http_error";
      params = { status: response.status };
    } else if (
      !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      reasonCode = "invalid_json";
    } else if (!reader) {
      reasonCode = "empty_response";
    } else {
      reasonCode = "invalid_json";
      let responseBytes = 0;
      let responseText = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        responseBytes += chunk.value.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          reasonCode = "response_too_large";
          params = { maxBytes: MAX_RESPONSE_BYTES };
          break;
        }
        responseText += decoder.decode(chunk.value, { stream: true });
      }
      if (reasonCode === "response_too_large") {
        return {
          url,
          status,
          checkedAt: new Date().toISOString(),
          reasonCode,
          ...(params ? { params } : {}),
        };
      }
      responseText += decoder.decode();
      const responseData: unknown = JSON.parse(responseText);
      reasonCode = "unexpected_response";
      if (healthResponseSchemas[serviceName].safeParse(responseData).success) {
        status = "connected";
        reasonCode = "reachable";
      }
    }
  } catch {
    if (requestSignal.aborted) reasonCode = "cancelled";
    else if (timeoutSignal.aborted) {
      reasonCode = "timeout";
      params = { timeoutMs: CHECK_TIMEOUT_MS };
    }
  } finally {
    completionController.abort();
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The combined abort signal may have already closed the body.
      } finally {
        reader.releaseLock();
      }
    }
  }
  return {
    url,
    status,
    checkedAt: new Date().toISOString(),
    reasonCode,
    ...(params ? { params } : {}),
  };
}

export function createConnectionStatusRoutes(
  environment: Environment,
  connectionStore: ConnectionStore,
) {
  return new Hono<AppContext>()
    .use(requireLocalManagementAccess(environment))
    .get("/status", async (c) => {
      const { services } = await connectionStore.read();
      const [agent, go2rtc] = await Promise.all([
        checkServiceConnection("agent", services.agent.url, c.req.raw.signal),
        checkServiceConnection("go2rtc", services.go2rtc.url, c.req.raw.signal),
      ]);
      return c.json({ services: { agent, go2rtc } } satisfies ServicesStatus);
    });
}
