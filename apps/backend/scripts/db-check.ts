import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { resolve } from "node:path";
import { loadEnvironment } from "../src/environment";
import { createDatabase } from "../src/db";

const environment = loadEnvironment();
if (!environment.DATABASE_URL)
  throw new Error("请在 .env 中配置 DATABASE_URL，再运行 bun run db:migrate。");
const database = createDatabase(environment.DATABASE_URL);
let connected = false;
let modifiedMigration = false;
try {
  const migrations = readMigrationFiles({
    migrationsFolder: resolve(import.meta.dir, "../drizzle"),
  });
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    connected = true;
    const extensions = await tx.execute(sql`
      SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'
    `);
    if (extensions.length === 0) throw new Error("missing extension");
    const applied = await tx.execute(sql`
      SELECT hash, created_at FROM drizzle.__drizzle_migrations
    `);
    for (const migration of migrations) {
      const row = applied.find(
        (entry) => Number(entry.created_at) === migration.folderMillis,
      );
      if (!row) throw new Error("pending migration");
      if (row.hash !== migration.hash) {
        modifiedMigration = true;
        throw new Error("modified migration");
      }
    }
  });
  console.info("Backend 数据库迁移和 TimescaleDB 已就绪。");
} catch {
  console.error(
    modifiedMigration
      ? "已执行的 backend 迁移与仓库文件不一致：请恢复原迁移文件，将结构变更写入新迁移；重跑 db:migrate 不会修复已有迁移。"
      : connected
        ? "Backend 数据库未就绪：请运行 bun run db:migrate；若仍失败，请检查数据库读取权限。"
        : "Backend 数据库检查失败：请检查 DATABASE_URL、数据库连接及迁移文件；数据库可连接后运行 bun run db:migrate。",
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
