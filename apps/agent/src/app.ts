import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { chatInputSchema } from "@home-agent/api/contracts";
import { AppError, validationIssues } from "@home-agent/api/errors";
import {
  errorResponse,
  handleHttpError,
  validateJson,
} from "@home-agent/api/errors/hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { agentReceiptQuerySchema } from "@home-agent/api/agent-receipts";
import {
  agentWorkflowInputSchema,
  agentWorkflowLimits,
} from "@home-agent/api/agent-workflows";
import { httpTracing } from "@home-agent/observability";
import type { createContextReceiver } from "./context/receiver";
import type { createWorkflows } from "./workflows";
import type { createChat } from "./chat";

export function createAgentApp({
  port,
  receiver,
  chat,
  runWorkflow,
}: {
  port: number;
  receiver: ReturnType<typeof createContextReceiver>;
  chat: ReturnType<typeof createChat>;
  runWorkflow: ReturnType<typeof createWorkflows>;
}) {
  const app = new Hono<{
    Bindings: Bun.Server<unknown>;
    Variables: { request: Request };
  }>();
  app.use(httpTracing());
  app.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    // bodyLimit can replace c.req.raw; Bun's timeout API needs the original request.
    c.set("request", c.req.raw);
    await next();
  });
  app.onError(handleHttpError);
  app.notFound((c) => errorResponse(c, new AppError("not_found")));
  return app
    .get("/health", (c) =>
      c.json({
        status: "ok",
        service: "home-agent",
        runtime: "bun",
        modelConfigured: Boolean(chat),
      }),
    )
    .use(requireLocalAccess([port]))
    .get("/api/received-context", (c) => c.json(receiver.snapshot()))
    .get(
      "/api/context-receipts",
      validator("query", (value) => {
        const parsed = agentReceiptQuerySchema.safeParse(value);
        if (!parsed.success)
          throw new AppError("invalid_request", {
            issues: validationIssues(parsed.error),
          });
        return parsed.data;
      }),
      (c) => c.json(receiver.receiptIndex(c.req.valid("query"))),
    )
    .get("/api/context-receipts/current", (c) =>
      c.json({
        journal_id: receiver.journalId(),
        context: receiver.snapshot(),
      }),
    )
    .get("/api/context-receipts/:id", (c) => {
      const result = receiver.receipt(c.req.param("id"));
      if (!result) throw new AppError("not_found");
      return c.json(result);
    })
    .post(
      "/api/chat",
      bodyLimit({
        maxSize: 32768,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
      validateJson(chatInputSchema),
      async (c) => {
        if (!chat) throw new AppError("model_not_configured");
        c.env.timeout(c.get("request"), 0);
        return c.json(await chat(c.req.valid("json"), c.req.raw.signal));
      },
    )
    .post(
      "/api/workflows",
      bodyLimit({
        maxSize: agentWorkflowLimits.requestBytes,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
      validateJson(agentWorkflowInputSchema),
      async (c) => {
        c.env.timeout(c.get("request"), 0);
        return c.json(await runWorkflow(c.req.valid("json"), c.req.raw.signal));
      },
    );
}
