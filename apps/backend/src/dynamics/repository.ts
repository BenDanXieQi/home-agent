import { and, desc, eq, lt, or } from "drizzle-orm";
import { mediaAnalysisCompletedSchema } from "@home-agent/agent/media-analysis/session";
import type { Database } from "../db";
import { contextRecords } from "../db/schema";
import { createHouseholdBindingAccess } from "../household/binding-repository";

export function createDynamicsRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  return {
    save(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      entry: ReturnType<typeof mediaAnalysisCompletedSchema.parse>,
      sourceEpoch: string,
    ) {
      return access(identity, assertCurrent, async (tx) => {
        await tx
          .insert(contextRecords)
          .values({
            id: entry.id,
            sourceKey: `media-analysis:${JSON.stringify([entry.source.deviceId, entry.source.channel, entry.startedAt, entry.endedAt, entry.kind, entry.includeAudio])}`,
            kind: "observation",
            topic: "media_analysis",
            summary: entry.reply,
            data: entry,
            certainty: "tentative",
            occurredAt: new Date(entry.startedAt),
            scopeEpoch: sourceEpoch,
            evidence: [
              {
                source: entry.source,
                startedAt: entry.startedAt,
                endedAt: entry.endedAt,
              },
            ],
          })
          .onConflictDoNothing({ target: contextRecords.sourceKey });
      });
    },
    history(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      before?: { at: number; id: string },
    ) {
      return access(identity, assertCurrent, async (tx) => {
        const rows = await tx
          .select({ data: contextRecords.data })
          .from(contextRecords)
          .where(
            and(
              eq(contextRecords.topic, "media_analysis"),
              before &&
                or(
                  lt(contextRecords.occurredAt, new Date(before.at)),
                  and(
                    eq(contextRecords.occurredAt, new Date(before.at)),
                    lt(contextRecords.id, before.id),
                  ),
                ),
            ),
          )
          .orderBy(desc(contextRecords.occurredAt), desc(contextRecords.id))
          .limit(21);
        const entries = rows
          .slice(0, 20)
          .map((row) => mediaAnalysisCompletedSchema.parse(row.data));
        const last = entries.at(-1);
        return {
          entries,
          next:
            rows.length > 20 && last
              ? { at: last.startedAt, id: last.id }
              : null,
        };
      });
    },
  };
}
