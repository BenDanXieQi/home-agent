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
import { createMaterialClient } from "./context/material-client";
import { createHistoryClient } from "./context/history-client";
import { agentReceiptQuerySchema } from "@home-agent/api/agent-receipts";
import { agentWorkflowLimits } from "@home-agent/api/agent-workflows";
import { createWorkflows } from "./workflows";
import {
  initializeTelemetry,
  withRequestSpan,
  currentTraceId,
} from "@home-agent/observability";

const telemetry = initializeTelemetry("home-agent-agent");
const config = loadConfig();
const receiver = createContextReceiver({ backendUrl: config.BACKEND_URL });
export const readHistory = createHistoryClient({
  backendUrl: config.BACKEND_URL,
  receiver,
});
export const readMaterial = createMaterialClient({
  backendUrl: config.BACKEND_URL,
  receiver,
});
const assistant = createAssistant(config);
const runWorkflow = createWorkflows(config);
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
      if (request.method === "GET" && path === "/api/context-receipts") {
        const query = agentReceiptQuerySchema.safeParse(
          Object.fromEntries(new URL(request.url).searchParams),
        );
        if (!query.success)
          throw new AppError("invalid_request", {
            issues: validationIssues(query.error),
          });
        return Response.json(receiver.receiptIndex(query.data), { headers });
      }
      if (request.method === "GET" && path === "/api/context-receipts/current")
        return Response.json(
          { journal_id: receiver.journalId(), context: receiver.snapshot() },
          { headers },
        );
      if (
        request.method === "GET" &&
        path.startsWith("/api/context-receipts/")
      ) {
        const result = receiver.receipt(
          path.slice("/api/context-receipts/".length),
        );
        if (!result) throw new AppError("not_found");
        return Response.json(result, { headers });
      }
      if (
        request.method !== "POST" ||
        (path !== "/api/chat" && path !== "/api/workflows")
      )
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
          path === "/api/workflows" ? agentWorkflowLimits.requestBytes : 32768,
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
      if (path === "/api/workflows") {
        listener.timeout(request, 0);
        return withRequestSpan(request, async () => {
          try {
            return Response.json(await runWorkflow(body, request.signal), {
              headers,
            });
          } catch (cause) {
            const error =
              cause instanceof AppError
                ? cause
                : new AppError("internal_error", { cause });
            return Response.json(errorPayload(error, currentTraceId()), {
              status: errorDefinitions[error.code].status,
              headers,
            });
          }
        });
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
    Promise.all([receiver.stop(), server.stop(true)])
      .finally(() => telemetry.shutdown())
      .catch(() => {
        console.error("Failed to stop Home Agent");
        process.exitCode = 1;
      });
  });
}
