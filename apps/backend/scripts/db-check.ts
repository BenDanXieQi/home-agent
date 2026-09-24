import { sql } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db";

const config = loadConfig();
if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required");
const database = createDatabase(config.DATABASE_URL);
try {
  const versions = await database.db.execute(sql`
    SELECT current_setting('server_version') AS postgres_version,
      extversion AS timescaledb_version
    FROM pg_extension WHERE extname = 'timescaledb'
  `);
  if (versions.length === 0) {
    throw new Error("TimescaleDB is not enabled; run bun run db:migrate");
  }
  console.info(versions[0]);
} finally {
  await database.close();
}
