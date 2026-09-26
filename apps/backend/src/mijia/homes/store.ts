import { eq } from "drizzle-orm";
import type { Database } from "../../db";
import { mijiaHomeSelections } from "../../db/schema";
import { MijiaError } from "../errors";

export function createHomeSelectionStore(db: Database) {
  return {
    async read(accountKey: string) {
      try {
        const [row] = await db
          .select()
          .from(mijiaHomeSelections)
          .where(eq(mijiaHomeSelections.accountKey, accountKey));
        return row?.homeId ?? null;
      } catch {
        throw new MijiaError("home_storage");
      }
    },
    async write(accountKey: string, homeId: string | null) {
      try {
        const data = { accountKey, homeId, updatedAt: new Date() };
        await db
          .insert(mijiaHomeSelections)
          .values(data)
          .onConflictDoUpdate({
            target: mijiaHomeSelections.accountKey,
            set: data,
          });
      } catch {
        throw new MijiaError("home_storage");
      }
    },
  };
}
export type HomeSelectionStore = ReturnType<typeof createHomeSelectionStore>;
