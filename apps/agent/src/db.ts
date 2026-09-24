import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";

export function createAgentDatabase(url: string) {
  const pool = new Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 20_000,
    statement_timeout: 30_000,
    application_name: "home-agent-agent",
  });
  pool.on("error", () =>
    console.error("Agent database idle connection failed"),
  );
  const checkpointer = new PostgresSaver(pool, undefined, {
    schema: "agent_state",
  });
  return { checkpointer, close: () => pool.end() };
}

export type AgentDatabase = ReturnType<typeof createAgentDatabase>;
