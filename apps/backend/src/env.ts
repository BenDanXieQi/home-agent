import type { Database } from "./db";

export type AppEnv = {
  Variables: {
    db: Database | undefined;
  };
};
