import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { completeAnswer } from "./answer";

export const Subagent = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "subagent",
      description:
        "Delegate a self-contained task to a subagent and get its answer back. Supply all needed context in task.",
      parameters: Type.Object({
        task: Type.String({ minLength: 1 }),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const childId = await api.commit(async (tx) => {
          const existing = (
            await tx.scanConversations({ ownerTaskId: api.taskId }, 1)
          ).items[0];
          if (existing) return existing.id;
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: api.taskId },
          });
          await configure(tx, child.id, {
            extensions: { remove: [Subagent] },
          });
          return child.id;
        }, context);
        await api.details({ conversationId: childId }, context);
        const child = await api.conversation(childId, context);
        if (!child)
          throw new Error("The delegated conversation is unavailable");
        const submission = await child.submit(
          {
            type: "input",
            content: args.task,
            requestId: `subagent:${api.taskId}`,
          },
          context,
        );
        const settled = await submission.wait(context);
        if (settled.status !== "done" || settled.type !== "input")
          throw new Error("The delegated task did not complete");
        const entry = await api.commit(
          (tx) => tx.entry(AssistantEntry, settled.answer),
          context,
        );
        const message = entry?.model?.[0];
        const answer = completeAnswer(
          message?.role === "assistant" ? message : undefined,
        );
        return {
          output: [{ type: "text" as const, text: answer }],
          details: { conversationId: childId },
        };
      },
    }),
  ],
});
