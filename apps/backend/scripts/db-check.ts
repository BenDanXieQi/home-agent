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
let baselineMismatch = false;
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
    baselineMismatch =
      applied.length !== migrations.length ||
      migrations.some(
        (migration) =>
          !applied.some(
            (entry) =>
              Number(entry.created_at) === migration.folderMillis &&
              entry.hash === migration.hash,
          ),
      );
    if (baselineMismatch) throw new Error("baseline mismatch");
  });
  console.info("Backend 数据库迁移和 TimescaleDB 已就绪。");
} catch {
  console.error(
    baselineMismatch
      ? "Backend 数据库与当前初始化基线不一致：请重建数据库，再按当前基线初始化。"
      : connected
        ? "Backend 数据库未就绪：请运行 bun run db:migrate；若仍失败，请检查数据库读取权限。"
        : "Backend 数据库检查失败：请检查 DATABASE_URL、数据库连接及迁移文件；数据库可连接后运行 bun run db:migrate。",
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
