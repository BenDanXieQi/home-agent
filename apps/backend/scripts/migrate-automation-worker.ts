import { runMigrations } from "graphile-worker";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
await runMigrations({ connectionString });
console.info("Automation worker schema is ready");
