import type { Pool } from "pg";
import type { z } from "zod";
import {
  chatThreadSchema,
  chatThreadCursorSchema,
  type chatHistoryListInputSchema,
} from "@home-agent/api/contracts";

const storedThread = chatThreadSchema.omit({ running: true });

/** Application-owned conversation summaries; checkpoint decoding stays with the saver. */
export function createChatThreads(pool: Pool) {
  return {
    async assertReady() {
      await pool.query(
        "SELECT thread_id FROM agent_state.chat_threads LIMIT 0",
      );
    },
    async touch(threadId: string, title: string, updatedAt = new Date()) {
      await pool.query(
        `INSERT INTO agent_state.chat_threads (thread_id, title, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (thread_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        [threadId, title.replace(/\s+/g, " ").slice(0, 80), updatedAt],
      );
    },
    async list(input: z.infer<typeof chatHistoryListInputSchema>) {
      const result = await pool.query(
        `SELECT thread_id AS "threadId", title,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
         FROM agent_state.chat_threads
         WHERE ($1::timestamptz IS NULL OR (updated_at, thread_id) < ($1::timestamptz, $2::uuid))
         ORDER BY updated_at DESC, thread_id DESC LIMIT $3`,
        [
          input.before?.updatedAt ?? null,
          input.before?.threadId ?? null,
          input.limit + 1,
        ],
      );
      const rows = storedThread.array().parse(result.rows);
      const threads = rows.slice(0, input.limit);
      return {
        threads,
        nextBefore:
          rows.length > input.limit
            ? chatThreadCursorSchema.parse(threads.at(-1))
            : null,
      };
    },
  };
}
