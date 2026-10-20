import type { Models, Tool, UserMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { LangfuseClient, ChatPromptClient } from "@langfuse/client";
import { awaitWithContext, type Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineExtension,
  section,
  wrapTool,
  type ToolRegistration,
  type RegistrySnapshot,
  type PromptSection,
} from "@earendil-works/pi-durable";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { withGenAiContext } from "@home-agent/observability";
import {
  langfuseConfigurationSchema,
  langfuseConnection,
} from "@home-agent/observability/langfuse";

export const promptConfigurationSchema = langfuseConfigurationSchema.extend({
  AGENT_PROMPT_LABEL: z.string().trim().min(1).default("production"),
});

const promptConfigSchema = z.strictObject({
  thinkingLevel: z.enum(MODEL_THINKING_LEVELS).default("off"),
  tools: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        description: z.string().min(1),
      }),
    )
    .refine(
      (tools) => new Set(tools.map(({ name }) => name)).size === tools.length,
      "Duplicate tool names",
    )
    .default([]),
  sections: z
    .array(
      z.strictObject({
        key: z.string().min(1),
        tag: z.boolean().default(true),
      }),
    )
    .refine(
      (sections) =>
        new Set(sections.map(({ key }) => key)).size === sections.length,
      "Duplicate section keys",
    )
    .default([]),
});

const promptTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Prompt must not be blank");

const chatMessageSchema = z.strictObject({
  type: z.literal("chatmessage").default("chatmessage"),
  role: z.enum(["system", "user"]),
  content: promptTextSchema,
});
const chatMessagesSchema = z.array(chatMessageSchema);
const compiledUserMessageSchema = z.strictObject({
  role: z.literal("user"),
  content: z.string(),
});
const compiledInputMessagesSchema = z.tuple([
  compiledUserMessageSchema,
  compiledUserMessageSchema,
]);

type VariableValues = NonNullable<Parameters<ChatPromptClient["compile"]>[0]>;

export type PromptVariables<Args extends unknown[]> =
  | VariableValues
  | ((...args: Args) => VariableValues | Promise<VariableValues>);

export async function resolvePromptVariables<Args extends unknown[]>(
  source: PromptVariables<Args> | undefined,
  ...args: Args
) {
  return typeof source === "function" ? source(...args) : (source ?? {});
}

function compilePromptMessages(
  prompt: Pick<
    ConstructorParameters<typeof ChatPromptClient>[0],
    "name" | "version" | "prompt"
  >,
  variables: VariableValues,
) {
  const messages: unknown = new ChatPromptClient({
    ...prompt,
    type: "chat",
    labels: [],
    tags: [],
  }).compile(variables);
  return messages;
}

export function createPromptResolver(
  configuration: z.output<typeof promptConfigurationSchema>,
) {
  const connection = langfuseConnection(configuration);
  const client =
    connection.publicKey && connection.secretKey
      ? new LangfuseClient(connection)
      : undefined;

  async function resolve({
    name,
    context,
    systemVariables,
  }: {
    name: string;
    context: Context;
    systemVariables?: PromptVariables<[context: Context]> | undefined;
  }) {
    context.abortSignal?.throwIfAborted();
    if (!client)
      throw new Error("Langfuse prompt management requires project API keys");

    const prompt = await awaitWithContext(
      client.prompt.get(name, {
        type: "chat",
        label: configuration.AGENT_PROMPT_LABEL,
        fetchTimeoutMs: 5_000,
      }),
      context,
    );
    context.abortSignal?.throwIfAborted();

    const variables = await resolvePromptVariables(systemVariables, context);
    context.abortSignal?.throwIfAborted();

    const messages = chatMessagesSchema.parse(prompt.prompt);
    const inputIndex = messages.findIndex(
      (message) => message.role !== "system",
    );
    const systemCount = inputIndex < 0 ? messages.length : inputIndex;

    const config = promptConfigSchema.parse(prompt.config);
    const systemMessages = chatMessagesSchema.parse(
      compilePromptMessages(
        {
          name: prompt.name,
          version: prompt.version,
          prompt: messages.slice(0, systemCount),
        },
        variables,
      ),
    );
    if (
      config.sections.length > 0 &&
      config.sections.length !== systemMessages.length
    )
      throw new Error(
        `Managed chat prompt ${name} must configure one section per system message`,
      );

    const sections = systemMessages.map(({ content }, index) => ({
      ...(config.sections[index] ?? {
        key: `managed_prompt_${index}`,
        tag: false,
      }),
      text: promptTextSchema.parse(content),
    }));
    const binding = {
      name: prompt.name,
      version: prompt.version,
      inputMessages: messages.slice(systemCount),
      tools: config.tools,
      sections,
    };

    return {
      config,
      binding,
      systemPrompt: sections
        .map(({ key, tag, text }) =>
          tag ? `<${key}>\n${text}\n</${key}>` : text,
        )
        .join("\n\n"),
    };
  }

  async function complete(
    {
      name,
      systemVariables,
      userVariables,
      model,
      modelCollection,
      tools,
    }: Omit<Parameters<typeof resolve>[0], "context"> & {
      userVariables: PromptVariables<[context: Context]>;
      model: Parameters<Models["completeSimple"]>[0];
      modelCollection: Models;
      tools: Omit<Tool, "description">[];
    },
    context: Context,
  ) {
    const prompt = await resolve({ name, systemVariables, context });
    const variables = await resolvePromptVariables(userVariables, context);
    context.abortSignal?.throwIfAborted();

    return withGenAiContext(promptGenerationAttributes(prompt.binding), () =>
      modelCollection.completeSimple(
        model,
        {
          systemPrompt: prompt.systemPrompt,
          messages: [
            {
              role: "user",
              content: compileDirectInput(prompt.binding, variables),
              timestamp: Date.now(),
            },
          ],
          tools: tools.map((tool) =>
            applyPromptTool(tool, prompt.config.tools),
          ),
        },
        {
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
          maxRetries: 0,
          ...(prompt.config.thinkingLevel === "off"
            ? {}
            : { reasoning: prompt.config.thinkingLevel }),
        },
      ),
    );
  }

  return { resolve, complete, close: async () => client?.shutdown() };
}

type PromptBinding = Awaited<
  ReturnType<ReturnType<typeof createPromptResolver>["resolve"]>
>["binding"];

export const PromptBindingDoc = defineDoc<{
  prompt?: PromptBinding;
}>({
  kind: "home.prompt-binding",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({}),
});

function compileDirectInput(binding: PromptBinding, variables: VariableValues) {
  const [input] = binding.inputMessages;
  if (binding.inputMessages.length !== 1 || !input || input.role !== "user")
    throw new Error(
      `Direct chat prompt ${binding.name} must contain system messages followed by one user template`,
    );

  const [message] = chatMessagesSchema.parse(
    compilePromptMessages(
      { name: binding.name, version: binding.version, prompt: [input] },
      variables,
    ),
  );
  if (!message) throw new Error(`Missing managed user prompt: ${binding.name}`);
  return [{ type: "text", text: message.content }] satisfies Exclude<
    UserMessage["content"],
    string
  >;
}

export function validateConversationPrompt(binding: PromptBinding) {
  const [input] = binding.inputMessages;

  if (
    binding.inputMessages.length !== 1 ||
    !input ||
    input.role !== "user" ||
    input.content.split("{{input}}").length !== 2
  )
    throw new Error(
      `Conversation prompt ${binding.name} must contain system messages followed by one user template containing exactly one {{input}}`,
    );
}

export function compileConversationInput(
  binding: PromptBinding,
  content: UserMessage["content"],
  variables: VariableValues,
) {
  const [input] = binding.inputMessages;
  if (!input) throw new Error(`Missing managed user prompt: ${binding.name}`);

  const originalContent =
    typeof content === "string"
      ? [{ type: "text" as const, text: content }]
      : content;

  const compiled = compilePromptMessages(
    {
      name: binding.name,
      version: binding.version,
      prompt: input.content
        .split("{{input}}")
        .map((text) => ({ ...input, content: text })),
    },
    variables,
  );

  const [beforeInput, afterInput] = compiledInputMessagesSchema.parse(compiled);
  const preparedContent = [...originalContent];

  if (beforeInput.content)
    preparedContent.unshift({ type: "text", text: beforeInput.content });

  if (afterInput.content)
    preparedContent.push({ type: "text", text: afterInput.content });

  return preparedContent;
}

function renderManagedPrompt(key: string) {
  return (async (input, context) => {
    const state = await input.read.snapshot(
      PromptBindingDoc,
      input.conversationId,
      context,
    );
    const text = state?.prompt?.sections.find(
      (candidate) => candidate.key === key,
    )?.text;
    if (text === undefined)
      throw new Error(`Missing managed prompt section: ${key}`);
    return text;
  }) satisfies PromptSection["render"];
}

export function promptGenerationAttributes(binding: PromptBinding) {
  return {
    "langfuse.observation.prompt.name": binding.name,
    "langfuse.observation.prompt.version": binding.version,
  };
}

export function applyPromptTool<T extends Pick<Tool, "name">>(
  tool: T,
  tools: PromptBinding["tools"],
) {
  const managed = tools.find(({ name }) => name === tool.name);
  if (!managed)
    throw new Error(`Missing managed tool declaration: ${tool.name}`);

  return { ...tool, description: managed.description };
}

export function createPromptExtension({
  binding,
  registry,
  tools,
}: {
  binding: PromptBinding;
  registry: RegistrySnapshot;
  tools: readonly ToolRegistration[];
}) {
  const selected = new Map(tools.map((tool) => [tool.name, tool]));

  for (const tool of selected.values()) applyPromptTool(tool, binding.tools);

  const extensionName = `managed-prompts:${JSON.stringify([binding.name, binding.version])}`;
  const existing = registry.extension(extensionName);
  if (existing) return existing;

  const managedTools = binding.tools;

  const targets = new Map(
    registry
      .tools()
      .filter(({ tool }) => managedTools.some(({ name }) => name === tool.name))
      .map(({ tool }) => [tool.name, tool]),
  );

  return defineExtension({
    name: extensionName,
    sections: binding.sections.map(({ key, tag }) =>
      section(key, renderManagedPrompt(key), { tag }),
    ),
    wraps: [...targets.values()].map((tool) =>
      wrapTool(tool, (original) => applyPromptTool(original, managedTools)),
    ),
  });
}
