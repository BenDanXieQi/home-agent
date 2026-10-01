import { AppError } from "@home-agent/api/errors";
import type { AgentDatabase } from "./db";

/** Owns admission while this single Agent process resets its household data. */
export function createHouseholdReset(database?: AgentDatabase) {
  let active = 0;
  let pending: { id: string; expiresAt: number } | undefined;
  let clearing = false;

  function current() {
    if (pending && !clearing && performance.now() >= pending.expiresAt)
      pending = undefined;
    return pending;
  }

  return {
    enter() {
      if (current()) throw new AppError("thread_busy");
      active++;
      let released = false;
      return () => {
        if (!released) active--;
        released = true;
      };
    },
    async prepare(id: string) {
      const existing = current();
      if (active || clearing || (existing && existing.id !== id))
        throw new AppError("thread_busy");
      pending = { id, expiresAt: performance.now() + 60_000 };
      clearing = true;
      try {
        // No persistence configured means there is no local checkpoint data.
        if (database) {
          const client = await database.pool.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL statement_timeout = '5s'");
            await client.query("SET LOCAL lock_timeout = '5s'");
            await client.query(
              "TRUNCATE agent_state.checkpoint_writes, agent_state.checkpoint_blobs, agent_state.checkpoints",
            );
            await client.query("COMMIT");
          } catch (cause) {
            await client.query("ROLLBACK");
            throw cause;
          } finally {
            client.release();
          }
        }
      } catch (cause) {
        pending = undefined;
        throw new AppError("persistence_unavailable", { cause });
      } finally {
        clearing = false;
      }
    },
    finish(id: string) {
      if (clearing) throw new AppError("thread_busy");
      if (pending?.id === id) pending = undefined;
    },
  };
}
