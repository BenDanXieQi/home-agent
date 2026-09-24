import type { Database } from "./db";

// Shared request-variable types for Hono apps and middleware; no runtime setup.
export type AppContext = {
  Variables: {
    db: Database | undefined;
  };
};
