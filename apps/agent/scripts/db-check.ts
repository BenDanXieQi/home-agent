import { loadConfig } from "../src/config";
import { createAgentDatabase } from "../src/db";

const config = loadConfig();
const url = config.AGENT_DATABASE_URL ?? config.DATABASE_URL;
if (!url)
  throw new Error(
    "请在 .env 中配置 AGENT_DATABASE_URL 或 DATABASE_URL，再运行 bun run db:migrate。",
  );

// checkpoint-postgres 1.0.5 has migrations 0–4. Review when upgrading the adapter.
const requiredMigrationVersion = 4;
const database = createAgentDatabase(url, { readOnly: true });
let connected = false;
try {
  await database.pool.query("SELECT 1");
  connected = true;
  const result = await database.pool.query<{ v: number }>(
    "SELECT v FROM agent_state.checkpoint_migrations",
  );
  const applied = new Set(result.rows.map((row) => row.v));
  for (let version = 0; version <= requiredMigrationVersion; version += 1) {
    if (!applied.has(version)) throw new Error("pending checkpoint migration");
  }
  // Exercise the adapter's read query without creating a conversation or tables.
  await database.checkpointer.getTuple({
    configurable: { thread_id: crypto.randomUUID() },
  });
  console.info("Agent checkpoint 迁移和表读取已就绪。");
} catch {
  console.error(
    connected
      ? "Agent checkpoint 存储未就绪：请运行 bun run db:migrate；若仍失败，请检查 agent_state 表及读取权限。"
      : "Agent 数据库无法连接：请检查 AGENT_DATABASE_URL（未设置时使用 DATABASE_URL）和数据库服务。",
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
