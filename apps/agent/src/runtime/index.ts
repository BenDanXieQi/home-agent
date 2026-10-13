import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  createModels,
  type Models,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  section,
  wrapTool,
  type ToolRegistration,
  type UserInput,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  SpanStatusCode,
  telemetryStatus,
  withSpan,
} from "@home-agent/observability";
import { completeAnswer } from "./answer";
import { Subagent } from "./delegation";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

export type AgentTools = readonly ToolRegistration[];

export function createAgentRuntime(
  sourceModels: Models,
  model: Model<Api>,
  options: {
    name?: string;
    instructions: string;
    timeoutMs?: number;
    maxRequests?: number;
    maxTokens: number;
    tools?: AgentTools;
  },
) {
  return {
    run: (input: UserInput, requestSignal: AbortSignal) =>
      withSpan(
        options.name ?? "agent",
        { "langfuse.observation.type": "agent" },
        async (span) => {
          const signal = AbortSignal.any([
            requestSignal,
            AbortSignal.timeout(options.timeoutMs ?? 120_000),
          ]);
          signal.throwIfAborted();
          if (span.isRecording() && telemetryStatus().includeContent)
            span.setAttribute(
              "langfuse.observation.input",
              JSON.stringify(input),
            );
          let requests = 0;
          const models = createModels();
          for (const provider of sourceModels.getProviders()) {
            models.setProvider({
              ...provider,
              streamSimple: (requestModel, transcript, streamOptions) => {
                signal.throwIfAborted();
                if (requests >= (options.maxRequests ?? 30))
                  throw new Error("Agent model request limit exceeded");
                requests++;
                return provider.streamSimple(requestModel, transcript, {
                  ...streamOptions,
                  maxTokens: Math.min(
                    requestModel.maxTokens,
                    options.maxTokens,
                    streamOptions?.maxTokens ?? options.maxTokens,
                  ),
                });
              },
            });
          }
          const registry = createRegistry();
          registry.install(CodingTools);
          registry.install(Subagent);
          registry.install(
            defineExtension({
              name: "workspace",
              sections: [section("cwd", (prompt) => prompt.env?.cwd)],
            }),
          );
          if (options.tools?.length)
            registry.install(
              defineExtension({ name: "domain-tools", tools: options.tools }),
            );
          registry.install(
            defineExtension({
              name: "tool-observations",
              wraps: registry
                .snapshot()
                .tools()
                .map(({ tool }) =>
                  wrapTool(tool, (original) => ({
                    ...original,
                    execute: (args, api, context) =>
                      withSpan(
                        `tool.${original.name}`,
                        {
                          "langfuse.observation.type": "tool",
                          "tool.name": original.name,
                          "agent.conversation.id": api.conversationId,
                        },
                        async (toolSpan) => {
                          if (
                            toolSpan.isRecording() &&
                            telemetryStatus().includeContent
                          )
                            toolSpan.setAttribute(
                              "langfuse.observation.input",
                              JSON.stringify(args),
                            );
                          try {
                            const result = await original.execute(
                              args,
                              api,
                              context,
                            );
                            const includeContent =
                              telemetryStatus().includeContent;
                            if (result.isError)
                              toolSpan.setStatus({
                                code: SpanStatusCode.ERROR,
                                message: includeContent
                                  ? result.diagnostics
                                      ?.filter((d) => d.severity === "error")
                                      .map((d) => d.message)
                                      .join("; ") || "Tool failed"
                                  : "Tool failed",
                              });
                            if (toolSpan.isRecording() && includeContent) {
                              if (result.diagnostics?.length)
                                toolSpan.setAttribute(
                                  "langfuse.observation.metadata.diagnostics",
                                  JSON.stringify(result.diagnostics),
                                );
                              toolSpan.setAttribute(
                                "langfuse.observation.output",
                                JSON.stringify(
                                  result.structuredOutput ??
                                    result.output ??
                                    api.retainedOutput().text,
                                ),
                              );
                            }
                            return result;
                          } catch (error) {
                            if (
                              toolSpan.isRecording() &&
                              telemetryStatus().includeContent
                            )
                              toolSpan.setAttribute(
                                "langfuse.observation.output",
                                JSON.stringify(api.retainedOutput().text),
                              );
                            throw error;
                          }
                        },
                      ),
                  })),
                ),
            }),
          );
          const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
          const workspace = await mkdtemp(join(tmpdir(), "home-agent-"));
          const env = new NodeExecutionEnv({ cwd: workspace });
          try {
            const harness = await Harness.open(
              new MemoryStorage(),
              {
                models,
                registry,
                env: () => env,
                settings: {
                  stream: {
                    maxRetries: 0,
                    ...(options.timeoutMs === undefined
                      ? {}
                      : { timeoutMs: options.timeoutMs }),
                  },
                  retry: { enabled: false, maxRetries: 0 },
                },
              },
              context,
            );
            try {
              const root = await harness.root(context, {
                agent: {
                  model: {
                    provider: model.provider,
                    modelId: model.id,
                  },
                  instructions: options.instructions,
                  cwd: workspace,
                },
              });
              const submission = await root.submit(
                { type: "input", content: input },
                context,
              );
              const settled = await submission.wait(context);
              signal.throwIfAborted();
              if (settled.status !== "done" || settled.type !== "input")
                throw new Error("The agent execution did not complete");
              const entry = await root.commit(
                (tx) => tx.entry(AssistantEntry, settled.answer),
                context,
              );
              const message = entry?.model?.[0];
              const answer = completeAnswer(
                message?.role === "assistant" ? message : undefined,
              );
              if (span.isRecording() && telemetryStatus().includeContent)
                span.setAttribute("langfuse.observation.output", answer);
              return answer;
            } finally {
              span.setAttribute("agent.model.requests", requests);
              await harness.close(BACKGROUND_CONTEXT);
            }
          } finally {
            try {
              await env.cleanup(BACKGROUND_CONTEXT);
            } finally {
              await rm(workspace, { recursive: true, force: true });
            }
          }
        },
      ),
  };
}
