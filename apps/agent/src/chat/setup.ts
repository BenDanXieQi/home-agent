import { z } from "zod";
import { isHumanMessage } from "@langchain/core/messages";
import type { AgentDatabase } from "../db";
import { checkpointMessages, messageText } from "./state";

/** Run during database setup, never during a history request or service startup. */
export async function setupChatStorage(database: AgentDatabase) {
  await database.pool.query(`
    CREATE TABLE IF NOT EXISTS agent_state.chat_threads (
      thread_id uuid PRIMARY KEY,
      title varchar(80) NOT NULL,
      updated_at timestamptz(3) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_threads_updated_at_idx
      ON agent_state.chat_threads (updated_at DESC, thread_id DESC);
  `);
  // Existing conversations receive summaries once; runtime reads only our table.
  const result = await database.pool.query(`
    SELECT DISTINCT checkpoints.thread_id
    FROM agent_state.checkpoints checkpoints
    LEFT JOIN agent_state.chat_threads threads
      ON checkpoints.thread_id = threads.thread_id::text
    WHERE checkpoints.checkpoint_ns = '' AND threads.thread_id IS NULL
      AND checkpoints.thread_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  `);
  const rows = z.array(z.object({ thread_id: z.uuid() })).parse(result.rows);
  for (const { thread_id: threadId } of rows) {
    const saved = await database.checkpointer.getTuple({
      configurable: { thread_id: threadId },
    });
    if (!saved) continue;
    const first = checkpointMessages(saved).find(isHumanMessage);
    await database.threads.touch(
      threadId,
      first ? messageText(first.content) || "新对话" : "未完成的对话",
      new Date(saved.checkpoint.ts),
    );
  }
}
