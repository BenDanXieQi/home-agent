import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
  MemoryStorage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  createLangfuseRuntimeFromBackend,
  createPiLangfuseDurableConversation,
  type ObservationAttributes,
  type TraceBackend,
} from "../src";

function captureTraces() {
  const records: {
    source: Parameters<TraceBackend["start"]>[1];
    attributes: ObservationAttributes;
    ends: number;
  }[] = [];
  const backend = {
    start(_id, source, attributes) {
      const record = { source, attributes, ends: 0 };
      records.push(record);
      return {
        update(update) {
          record.attributes = {
            ...record.attributes,
            ...update,
            metadata: { ...record.attributes.metadata, ...update.metadata },
          };
          return this;
        },
        end() {
          record.ends += 1;
          return this;
        },
      };
    },
    async forceFlush() {},
    async shutdown() {},
  } satisfies TraceBackend;
  return { records, backend };
}

async function openConversation(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  tools: ToolRegistration[] = [],
) {
  await using resources = new AsyncDisposableStack();
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const extension = defineExtension({ name: "trace-test", tools });
  registry.install(extension);
  const reports: unknown[] = [];
  const harness = resources.adopt(
    await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry,
        settings: {
          retry: { enabled: false },
          stream: { maxRetries: 0 },
          followUpMode: "all",
        },
        onReport(error) {
          reports.push(error);
        },
      },
      context,
    ),
    (value) => value.close(context),
  );
  const model = faux.getModel();
  const conversation = await harness.root(context, {
    agent: {
      model: { provider: model.provider, modelId: model.id },
      extensions: [extension],
    },
  });
  const { records, backend } = captureTraces();
  const runtime = resources.adopt(
    createLangfuseRuntimeFromBackend(backend),
    (value) => value.shutdown(),
  );
  const errors: string[] = [];
  const observer = resources.adopt(
    await createPiLangfuseDurableConversation(runtime, {
      harness,
      conversationId: conversation.id,
      context,
      captureContent: true,
      onError(stage) {
        errors.push(stage);
      },
    }),
    (value) => value.dispose(),
  );
  expect(observer.active).toBe(true);
  const owned = resources.move();
  return {
    harness,
    conversation,
    observer,
    records,
    reports,
    errors,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test("records nested tool results and the final answer before reporting a submission observed", async () => {
  const nested = defineTool({
    name: "nested",
    description: "Return a structured result",
    parameters: { type: "object", properties: {} } as const,
    structuredOutputSchema: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
    } as const,
    execute: async () => ({
      output: [{ type: "text" as const, text: "forty-two" }],
      structuredOutput: { value: 42 },
      details: { origin: "fixture" },
    }),
  });
  const outer = defineTool({
    name: "outer",
    description: "Call the nested tool",
    parameters: { type: "object", properties: {} } as const,
    execute: async (_args, api, execution) => {
      const result = await api.executeTool("nested", {}, execution);
      return {
        output: [
          {
            type: "text" as const,
            text: JSON.stringify(result.structuredOutput),
          },
        ],
      };
    },
  });
  await using fixture = await openConversation(
    [
      fauxAssistantMessage(fauxToolCall("outer", {}, { id: "outer-call" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("The result is 42."),
    ],
    [outer, nested],
  );
  const submission = await fixture.conversation.submit(
    { type: "input", content: "Calculate it", requestId: "trace-request" },
    context,
  );
  const observed = fixture.observer.whenSubmissionObserved(submission.id);
  expect((await submission.wait(context)).status).toBe("done");
  expect(await observed).toBe(true);

  const tools = fixture.records.filter(
    (record) => record.source.kind === "tool",
  );
  expect(tools).toHaveLength(2);
  const child = tools.find(
    (record) =>
      record.source.kind === "tool" && record.source.call.name === "nested",
  );
  expect(child?.source).toMatchObject({ call: { parentCallId: "outer-call" } });
  expect(child?.attributes).toMatchObject({
    output: { value: 42 },
    level: "DEFAULT",
    metadata: { "pi.durable.tool_details": { origin: "fixture" } },
  });
  expect(tools.every((record) => record.ends === 1)).toBe(true);
  const run = fixture.records.find((record) => record.source.kind === "run");
  expect(run?.ends).toBe(1);
  expect(run?.attributes).toMatchObject({
    level: "DEFAULT",
    metadata: { "pi.durable.submission_status": "done" },
  });
  expect(JSON.stringify(run?.attributes.output)).toContain("The result is 42.");
  expect(
    fixture.records.filter((record) => record.source.kind === "generation"),
  ).toHaveLength(2);
  expect(fixture.errors).toEqual([]);
  expect(fixture.reports).toEqual([]);
});

test("settles a failed model response as an observed error", async () => {
  await using fixture = await openConversation([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Fixture model failed",
    }),
  ]);
  const submission = await fixture.conversation.submit(
    { type: "input", content: "Answer" },
    context,
  );
  expect(await submission.wait(context)).toMatchObject({
    status: "unanswered",
    reason: "model_error",
  });
  expect(await fixture.observer.whenSubmissionObserved(submission.id)).toBe(
    true,
  );
  const run = fixture.records.find((record) => record.source.kind === "run");
  expect(run?.ends).toBe(1);
  expect(run?.attributes.level).toBe("ERROR");
  const live = await fixture.harness.snapshot(
    LiveDoc,
    fixture.conversation.id,
    context,
  );
  expect(live?.runFailure?.taskId).toBeDefined();
  expect(run?.attributes.metadata?.["pi.durable.failed_task_id"]).toBe(
    live?.runFailure?.taskId,
  );
  expect(fixture.errors).toEqual([]);
});

test("keeps a nested tool's text error visible without a structured output schema", async () => {
  const nested = defineTool({
    name: "nested",
    description: "Return an error",
    parameters: { type: "object", properties: {} } as const,
    execute: async () => ({
      output: [{ type: "text" as const, text: "Fixture tool failed" }],
      isError: true,
    }),
  });
  const outer = defineTool({
    name: "outer",
    description: "Call the failing tool",
    parameters: { type: "object", properties: {} } as const,
    execute: async (_args, api, execution) => {
      await api.executeTool("nested", {}, execution);
      return { output: [{ type: "text" as const, text: "Handled" }] };
    },
  });
  await using fixture = await openConversation(
    [
      fauxAssistantMessage(fauxToolCall("outer", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Handled the error"),
    ],
    [outer, nested],
  );
  const submission = await fixture.conversation.submit(
    { type: "input", content: "Try the tool" },
    context,
  );
  expect((await submission.wait(context)).status).toBe("done");
  expect(await fixture.observer.whenSubmissionObserved(submission.id)).toBe(
    true,
  );
  const child = fixture.records.find(
    (record) =>
      record.source.kind === "tool" && record.source.call.name === "nested",
  );
  expect(child?.attributes).toMatchObject({
    output: "Fixture tool failed",
    level: "ERROR",
    statusMessage: "Fixture tool failed",
  });
  expect(child?.ends).toBe(1);
  expect(fixture.errors).toEqual([]);
});

test("finishes a merged run before reporting either input observed", async () => {
  const started = Promise.withResolvers<void>();
  const answer =
    Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  await using fixture = await openConversation([
    async () => {
      started.resolve();
      return answer.promise;
    },
    fauxAssistantMessage("Merged answer"),
  ]);
  try {
    await fixture.conversation.submit(
      { type: "input", content: "First" },
      context,
    );
    await started.promise;
    const second = await fixture.conversation.submit(
      { type: "input", content: "Second", whenBusy: "followUp" },
      context,
    );
    const third = await fixture.conversation.submit(
      { type: "input", content: "Third", whenBusy: "followUp" },
      context,
    );
    const observed = fixture.observer
      .whenSubmissionObserved(second.id)
      .then((value) => {
        const run = fixture.records.find(
          (record) =>
            record.source.kind === "run" && record.source.primary === second.id,
        );
        return { value, ends: run?.ends, input: run?.attributes.input };
      });
    answer.resolve(fauxAssistantMessage("First answer"));

    const result = await observed;
    expect(result).toMatchObject({ value: true, ends: 1 });
    expect(JSON.stringify(result.input)).toContain("Second");
    expect(JSON.stringify(result.input)).toContain("Third");
    expect(await fixture.observer.whenSubmissionObserved(third.id)).toBe(true);
    expect(
      fixture.records.filter((record) => record.source.kind === "run"),
    ).toHaveLength(2);
    expect(fixture.errors).toEqual([]);
  } finally {
    answer.resolve(fauxAssistantMessage("Released"));
  }
});

test("disposing tracing releases its wait without cancelling the conversation", async () => {
  const started = Promise.withResolvers<void>();
  const answer =
    Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  await using fixture = await openConversation([
    async () => {
      started.resolve();
      return answer.promise;
    },
  ]);
  try {
    const submission = await fixture.conversation.submit(
      { type: "input", content: "Wait" },
      context,
    );
    const observed = fixture.observer.whenSubmissionObserved(submission.id);
    await started.promise;
    await fixture.observer.dispose();
    expect(await observed).toBe(false);
    expect(fixture.observer.active).toBe(false);
    answer.resolve(fauxAssistantMessage("Still answered"));
    expect((await submission.wait(context)).status).toBe("done");
    expect(fixture.errors).toEqual([]);
    expect(fixture.records.every((record) => record.ends === 1)).toBe(true);
  } finally {
    answer.resolve(fauxAssistantMessage("Released"));
  }
});
