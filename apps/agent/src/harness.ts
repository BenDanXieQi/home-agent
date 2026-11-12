import {
  BACKGROUND_CONTEXT,
  type Context,
} from "@earendil-works/chord/context";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import {
  ProviderDoc,
  type Cursor,
  type ConversationCreateOptions,
  type ConversationHandle,
  type Harness,
} from "@earendil-works/pi-durable";
import { AppError } from "@home-agent/api/errors";
import { bindTraceSession, withGenAiContext } from "@home-agent/observability";
import {
  createDurableTracing,
  type createObservedHarnessOptions,
} from "@home-agent/observability/durable";
import { attemptAsync, memoize } from "es-toolkit";
import {
  createPromptExtension,
  PromptBindingDoc,
  promptGenerationAttributes,
  compileConversationInput,
  resolvePromptVariables,
  validateConversationPrompt,
  type createPromptResolver,
  type PromptVariables,
} from "./prompts";

type ManagedConversationOptions = {
  agentName: string;
  sessionId?: string | undefined;
};

export function createAgentHarness({
  harness,
  frameworkExtensions,
  extensionRegistry,
  prompts,
}: {
  harness: Harness;
  frameworkExtensions: ReturnType<
    typeof createObservedHarnessOptions
  >["observationExtension"][];
  extensionRegistry: ReturnType<
    typeof createObservedHarnessOptions
  >["extensionRegistry"];
  prompts: ReturnType<typeof createPromptResolver>;
}) {
  let closed = false;
  const pendingInitializations = new Set<Promise<unknown>>();
  const conversationClosers = new Map<
    ConversationHandle["id"],
    (() => Promise<void>) | undefined
  >();
  const nativeSubmitByHandle = new WeakMap<
    ConversationHandle,
    ConversationHandle["submit"]
  >();
  type ManagedPromptOptions = {
    prompt: Omit<Parameters<typeof prompts.resolve>[0], "context"> & {
      userVariables?:
        | PromptVariables<
            [
              conversation: Pick<
                Awaited<ReturnType<Harness["createConversation"]>>,
                "id" | "commit"
              >,
              context: Context,
            ]
          >
        | undefined;
    };
  };

  async function initialize<T extends ConversationHandle>(
    open: () => Promise<T>,
  ) {
    if (closed) throw new AppError("request_cancelled");

    const pending = attemptAsync(open);
    pendingInitializations.add(pending);

    const [error, conversation] = await pending;
    pendingInitializations.delete(pending);

    if (conversation === null) throw error;
    return conversation;
  }

  async function prepareManagedConversation<
    Conversation extends ConversationHandle,
  >({
    conversation,
    agentName,
    sessionId: requestedSessionId,
    context,
    userVariables,
  }: ManagedConversationOptions & {
    conversation: Conversation;
    context: Context;
    userVariables?: ManagedPromptOptions["prompt"]["userVariables"];
  }) {
    if (conversationClosers.has(conversation.id))
      throw new Error("The conversation is already managed");

    conversationClosers.set(conversation.id, undefined);
    await using resources = new AsyncDisposableStack();
    resources.defer(() => {
      conversationClosers.delete(conversation.id);
    });

    let providerSessionId: string | undefined;
    resources.defer(async () => {
      const id =
        providerSessionId ??
        (
          await harness.snapshot(
            ProviderDoc,
            conversation.id,
            BACKGROUND_CONTEXT,
          )
        )?.sessionId;
      if (id) cleanupSessionResources(id);
    });

    const promptState = await harness.snapshot(
      PromptBindingDoc,
      conversation.id,
      context,
    );
    const prompt = promptState?.prompt;
    if (!prompt) throw new Error("The conversation has no managed prompt");
    validateConversationPrompt(prompt);

    const tracing = resources.adopt(
      createDurableTracing({
        harness,
        agentName,
        generationAttributes: promptGenerationAttributes(prompt),
      }),
      (instance) => instance.close(),
    );
    resources.defer(() => tracing.detach(conversation.id));

    const unboundConversation = await harness.conversation(
      conversation.id,
      BACKGROUND_CONTEXT,
    );
    if (!unboundConversation)
      throw new Error("The managed conversation is unavailable");
    resources.defer(async () => {
      // A failed attachment must not resume restored work during cleanup.
      if (!conversationClosers.get(conversation.id)) return;

      if ((await harness.inspect(BACKGROUND_CONTEXT)).scheduling === "paused")
        return;

      await unboundConversation.abort(BACKGROUND_CONTEXT, {
        background: true,
      });
    });

    const agent = await unboundConversation.agent(context);
    const promptExtension = createPromptExtension({
      binding: prompt,
      registry: extensionRegistry.snapshot(),
      tools: [...agent.tools, ...agent.deferred, ...agent.callable],
    });
    if (!extensionRegistry.snapshot().extension(promptExtension.name))
      extensionRegistry.install(promptExtension);

    const requiredExtensions = [promptExtension, ...frameworkExtensions];
    const missingExtensions = requiredExtensions.filter(
      (extension) =>
        !agent.extensions.some(({ name }) => name === extension.name),
    );
    if (missingExtensions.length)
      await unboundConversation.configure(
        { extensions: [...missingExtensions, ...agent.extensions] },
        context,
      );

    const provider = await harness.snapshot(
      ProviderDoc,
      conversation.id,
      context,
    );
    if (!provider) throw new Error("The conversation has no provider session");

    providerSessionId = provider.sessionId;
    const sessionId = requestedSessionId ?? providerSessionId;
    const observationSessionId = `${prompt.name}:${sessionId}`;
    const traceConversationId = providerSessionId;
    bindTraceSession(observationSessionId);
    await tracing.attach(
      conversation.id,
      observationSessionId,
      traceConversationId,
    );

    context.abortSignal?.throwIfAborted();
    if (closed) throw new AppError("request_cancelled");

    const ownedResources = resources.move();
    const close = memoize(() => ownedResources.disposeAsync());
    conversationClosers.set(conversation.id, close);

    function withTraceContext<T>(run: () => T) {
      return withGenAiContext(
        {
          "gen_ai.agent.name": agentName,
          "session.id": observationSessionId,
          "gen_ai.conversation.id": traceConversationId,
        },
        run,
      );
    }

    const nativeSubmit =
      nativeSubmitByHandle.get(conversation) ??
      conversation.submit.bind(conversation);
    nativeSubmitByHandle.set(conversation, nativeSubmit);

    function assertCanSubmit(execution: Context) {
      execution.abortSignal?.throwIfAborted();
      if (ownedResources.disposed || closed)
        throw new AppError("request_cancelled");
    }

    const submissionTarget = {
      id: conversation.id,
      submit(...args: Parameters<ConversationHandle["submit"]>) {
        assertCanSubmit(args[1]);
        return nativeSubmit(...args);
      },
    };
    const variableConversation = {
      id: conversation.id,
      commit: unboundConversation.commit.bind(unboundConversation),
    };

    return Object.assign(conversation, {
      sessionId,
      commit: unboundConversation.commit.bind(unboundConversation),
      async submit(
        input: Parameters<Conversation["submit"]>[0],
        execution: Context,
      ) {
        assertCanSubmit(execution);

        let prepared = input;
        if (input.type === "input") {
          const variables = await resolvePromptVariables(
            userVariables,
            variableConversation,
            execution,
          );
          assertCanSubmit(execution);

          prepared = {
            ...input,
            content: compileConversationInput(prompt, input.content, variables),
          };
        }
        return withTraceContext(() =>
          tracing.submit(submissionTarget, prepared, execution),
        );
      },
      withTraceContext,
      close,
      [Symbol.asyncDispose]: close,
    });
  }

  async function prepareConversation<
    Options extends Pick<ConversationCreateOptions, "agent" | "init">,
  >({ prompt, ...options }: Options & ManagedPromptOptions, context: Context) {
    if (options.agent?.thinkingLevel !== undefined)
      throw new Error("A managed prompt owns conversation thinkingLevel");

    const resolved = await prompts.resolve({
      ...prompt,
      context,
    });
    validateConversationPrompt(resolved.binding);
    context.abortSignal?.throwIfAborted();
    if (closed) throw new AppError("request_cancelled");

    return {
      ...options,
      agent: {
        ...options.agent,
        thinkingLevel: resolved.config.thinkingLevel,
      },
      init: async (
        ...[tx, id]: Parameters<NonNullable<ConversationCreateOptions["init"]>>
      ) => {
        const state = await tx.doc(PromptBindingDoc, id);
        state.prompt = resolved.binding;
        await options.init?.(tx, id);
      },
    };
  }

  async function resetConversations(context: Context) {
    const { tasks } = await harness.inspect(context);
    await Promise.all(
      tasks.map(({ record }) => harness.abortTask(record.id, context)),
    );

    // Include stored conversations whose Agent is currently disabled.
    let cursor: Cursor | undefined;
    do {
      const page = await harness.commit(
        (tx) => tx.scanConversations({}, 256, cursor),
        context,
      );
      for (const { id } of page.items) {
        const conversation = await harness.conversation(id, context);
        if (!conversation)
          throw new Error("The stored conversation is unavailable");

        await conversation.abort(context, { background: true });
        await conversation.reset(undefined, context);
      }
      cursor = page.next;
    } while (cursor);
  }

  const close = memoize(async () => {
    closed = true;
    await Promise.allSettled(pendingInitializations);

    const results = await Promise.allSettled(
      Array.from(conversationClosers.values(), async (closeConversation) => {
        await closeConversation?.();
      }),
    );

    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Agent conversations close failed");
  });

  return {
    resetConversations,
    commit: harness.commit.bind(harness),
    conversation: harness.conversation.bind(harness),
    resume: () => harness.resume(),
    watchDoc: harness.watchDoc.bind(harness),
    createConversation(
      {
        agentName,
        sessionId,
        ...options
      }: ManagedConversationOptions &
        ConversationCreateOptions &
        ManagedPromptOptions,
      context: Context,
    ) {
      return initialize(async () => {
        const conversation = await harness.createConversation(
          await prepareConversation(options, context),
          context,
        );
        return prepareManagedConversation({
          conversation,
          agentName,
          sessionId,
          context,
          userVariables: options.prompt.userVariables,
        });
      });
    },
    root(
      context: Context,
      {
        agentName,
        sessionId,
        ...options
      }: ManagedConversationOptions &
        NonNullable<Parameters<Harness["root"]>[1]> &
        ManagedPromptOptions,
    ) {
      return initialize(async () => {
        const conversation = await harness.root(
          context,
          await prepareConversation(options, context),
        );
        return prepareManagedConversation({
          conversation,
          agentName,
          sessionId,
          context,
          userVariables: options.prompt.userVariables,
        });
      });
    },
    prepareManagedConversation<Conversation extends ConversationHandle>(
      options: ManagedConversationOptions & {
        conversation: Conversation;
        context: Context;
        prompt?: Pick<ManagedPromptOptions["prompt"], "userVariables">;
      },
    ) {
      return initialize(() =>
        prepareManagedConversation({
          ...options,
          userVariables: options.prompt?.userVariables,
        }),
      );
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
