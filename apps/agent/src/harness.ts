import {
  BACKGROUND_CONTEXT,
  type Context,
} from "@earendil-works/chord/context";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import {
  ProviderDoc,
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
import { memo as once, tryit } from "radash";

type ConversationObservationOptions = {
  agentName: string;
  sessionId?: string | undefined;
};

export function createAgentHarness(
  harness: Harness,
  observationExtension: ReturnType<
    typeof createObservedHarnessOptions
  >["observationExtension"],
) {
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

  async function initialize<T extends ConversationHandle>(
    open: () => Promise<T>,
  ) {
    if (closed) throw new AppError("request_cancelled");

    const pending = tryit(open)();
    pendingInitializations.add(pending);

    const [error, conversation] = await pending;
    pendingInitializations.delete(pending);

    if (conversation === undefined) throw error;
    return conversation;
  }

  async function observe<Conversation extends ConversationHandle>(
    conversation: Conversation,
    options: ConversationObservationOptions,
    context: Context,
    traceIdentitySource: "session" | "conversation",
  ) {
    if (conversationClosers.has(conversation.id))
      throw new Error("The conversation is already observed");

    // Reserve the conversation before asynchronous setup to prevent duplicate observers.
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

    const tracing = resources.adopt(
      createDurableTracing(harness, options.agentName),
      (instance) => instance.close(),
    );
    resources.defer(() => tracing.detach(conversation.id));

    // Tool handles inherit invocation cancellation; cleanup needs an unbound handle.
    const unboundConversation = await harness.conversation(
      conversation.id,
      BACKGROUND_CONTEXT,
    );
    if (!unboundConversation)
      throw new Error("The observed conversation is unavailable");
    resources.defer(() =>
      unboundConversation.abort(BACKGROUND_CONTEXT, { background: true }),
    );

    const agent = await unboundConversation.agent(context);
    if (
      !agent.extensions.some(({ name }) => name === observationExtension.name)
    )
      await unboundConversation.configure(
        { extensions: [...agent.extensions, observationExtension] },
        context,
      );

    const provider = await harness.snapshot(
      ProviderDoc,
      conversation.id,
      context,
    );
    if (!provider) throw new Error("The conversation has no provider session");

    providerSessionId = provider.sessionId;
    const sessionId = options.sessionId ?? providerSessionId;
    const traceConversationId =
      traceIdentitySource === "session" ? sessionId : String(conversation.id);
    bindTraceSession(sessionId);
    await tracing.attach(conversation.id, sessionId, traceConversationId);

    context.abortSignal?.throwIfAborted();
    if (closed) throw new AppError("request_cancelled");

    const ownedResources = resources.move();
    const close = once(() => ownedResources.disposeAsync());
    conversationClosers.set(conversation.id, close);

    function withTraceContext<T>(run: () => T) {
      return withGenAiContext(
        {
          "session.id": sessionId,
          "gen_ai.conversation.id": traceConversationId,
        },
        run,
      );
    }

    const submissionTarget = {
      id: conversation.id,
      submit:
        nativeSubmitByHandle.get(conversation) ??
        conversation.submit.bind(conversation),
    };
    nativeSubmitByHandle.set(conversation, submissionTarget.submit);

    return Object.assign(conversation, {
      sessionId,
      async submit(
        input: Parameters<Conversation["submit"]>[0],
        execution: Context,
      ) {
        if (ownedResources.disposed || closed)
          throw new AppError("request_cancelled");

        return withTraceContext(() =>
          tracing.submit(submissionTarget, input, execution),
        );
      },
      withTraceContext,
      close,
      [Symbol.asyncDispose]: close,
    });
  }

  const close = once(async () => {
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
    watchDoc: harness.watchDoc.bind(harness),
    createConversation(
      {
        agentName,
        sessionId,
        ...options
      }: ConversationObservationOptions & ConversationCreateOptions,
      context: Context,
    ) {
      return initialize(async () => {
        const conversation = await harness.createConversation(options, context);
        return observe(
          conversation,
          { agentName, sessionId },
          context,
          "session",
        );
      });
    },
    root(
      context: Context,
      {
        agentName,
        sessionId,
        ...options
      }: ConversationObservationOptions &
        NonNullable<Parameters<Harness["root"]>[1]>,
    ) {
      return initialize(async () => {
        const conversation = await harness.root(context, options);
        return observe(
          conversation,
          { agentName, sessionId },
          context,
          "conversation",
        );
      });
    },
    observeConversation<Conversation extends ConversationHandle>(
      conversation: Conversation,
      options: ConversationObservationOptions,
      context: Context,
    ) {
      return initialize(() =>
        observe(conversation, options, context, "conversation"),
      );
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
