import { AIMessage } from "@langchain/core/messages";
import { chatInputSchema, chatResponseSchema } from "@home-agent/api/contracts";
import {
  AppError,
  errorDefinitions,
  errorPayload,
  validationIssues,
} from "@home-agent/api/errors";
import { createLocalAccessCheck } from "@home-agent/api/http/local-access-policy";
import {
  readLimitedJson,
  ResponseBodyError,
} from "@home-agent/api/http/read-body";
import { createAssistant } from "./assistant";
import { loadConfig } from "./config";
import { createContextReceiver } from "./context/receiver";
import { createHistoryClient } from "./context/history-client";

const config = loadConfig();
const receiver = createContextReceiver({ backendUrl: config.BACKEND_URL });
export const readHistory = createHistoryClient({
  backendUrl: config.BACKEND_URL,
  receiver,
});
const assistant = createAssistant(config);
const allowed = createLocalAccessCheck([config.AGENT_PORT]);
const server = Bun.serve({
  hostname: config.AGENT_HOST,
  port: config.AGENT_PORT,
  async fetch(request, listener) {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/health")
        return Response.json(
          {
            status: "ok",
            service: "home-agent",
            runtime: "bun",
            modelConfigured: Boolean(assistant),
          },
          { headers },
        );
      if (!allowed(request, listener.requestIP(request)?.address))
        throw new AppError("local_access_required");
      if (request.method === "GET" && path === "/api/received-context")
        return Response.json(receiver.snapshot(), { headers });
      if (request.method !== "POST" || path !== "/api/chat")
        throw new AppError("not_found");
      if (
        request.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new AppError("content_type_required");
      let body: unknown;
      try {
        body = await readLimitedJson(
          new Response(request.body),
          32768,
          request.signal,
        );
      } catch (cause) {
        throw new AppError(
          cause instanceof ResponseBodyError &&
            cause.code === "response_too_large"
            ? "request_too_large"
            : "invalid_json",
          { cause },
        );
      }
      const input = chatInputSchema.safeParse(body);
      if (!input.success)
        throw new AppError("invalid_request", {
          issues: validationIssues(input.error),
        });
      if (!assistant) throw new AppError("model_not_configured");
      listener.timeout(request, 0);
      const timeout = AbortSignal.timeout(config.AGENT_RUN_TIMEOUT_MS);
      const signal = AbortSignal.any([request.signal, timeout]);
      try {
        const result = await assistant.invoke(
          { messages: [{ role: "user", content: input.data.message }] },
          { signal, recursionLimit: 30 },
        );
        signal.throwIfAborted();
        const answer = result.messages.at(-1);
        if (
          !answer ||
          !AIMessage.isInstance(answer) ||
          answer.tool_calls?.length ||
          answer.invalid_tool_calls?.length ||
          answer.response_metadata.finish_reason === "length" ||
          answer.response_metadata.finish_reason === "content_filter" ||
          answer.response_metadata.status === "incomplete" ||
          answer.response_metadata.status === "failed"
        )
          throw new AppError("agent_execution_failed");
        return Response.json(
          chatResponseSchema.parse({ answer: answer.text }),
          { headers },
        );
      } catch (cause) {
        throw new AppError(
          request.signal.aborted
            ? "request_cancelled"
            : timeout.aborted
              ? "run_timeout"
              : "agent_execution_failed",
          { cause },
        );
      }
    } catch (cause) {
      const error =
        cause instanceof AppError
          ? cause
          : new AppError("internal_error", { cause });
      return Response.json(errorPayload(error), {
        status: errorDefinitions[error.code].status,
        headers,
      });
    }
  },
});
receiver.start();
console.info(`Home Agent listening on ${server.url.toString()}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    Promise.all([receiver.stop(), server.stop(true)]).catch(() => {
      console.error("Failed to stop Home Agent");
      process.exitCode = 1;
    });
  });
}
