import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDatabase(url: string) {
  const client = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: "home-agent-backend",
      statement_timeout: 5000,
      lock_timeout: 5000,
    },
  });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end({ timeout: 5 }) };
}

export type Database = ReturnType<typeof createDatabase>["db"];
