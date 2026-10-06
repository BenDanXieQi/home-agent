import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import {
  householdEventReceiptSchema,
  householdEventSubmissionSchema,
  type householdEventIdentitySchema,
  type householdEventQuerySchema,
} from "@home-agent/api/household-events";
import type { Database } from "../../db";
import type { Transaction } from "../../db/transaction-outcome";
import { createHouseholdBindingAccess } from "../binding-repository";
import { householdEvents } from "./schema";
import { HouseholdEventError } from "./errors";

function receipt(row: typeof householdEvents.$inferSelect) {
  return householdEventReceiptSchema.parse({
    ...row.submission,
    accepted_at: row.acceptedAt.toISOString(),
  });
}

const matches = (key: ReturnType<typeof householdEventIdentitySchema.parse>) =>
  "id" in key
    ? eq(householdEvents.id, key.id)
    : and(
        eq(householdEvents.producerId, key.producer_id),
        eq(householdEvents.sourceEventId, key.source_event_id),
      );

/** Owns event identity and acceptance; consumers are notified after commit. */
export function createHouseholdEventRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  const within = (identity: Parameters<typeof access>[0]) =>
    and(
      eq(householdEvents.accountId, identity.accountId),
      eq(householdEvents.homeId, identity.homeId ?? ""),
    );
  async function acceptInTransaction(
    tx: Transaction,
    identity: Parameters<typeof access>[0],
    submission: ReturnType<typeof householdEventSubmissionSchema.parse>,
    assertCurrent: () => void,
    validate?: (
      tx: Transaction,
      event: typeof submission.event,
    ) => Promise<void>,
  ) {
    submission = householdEventSubmissionSchema.parse(submission);
    if (Buffer.byteLength(JSON.stringify(submission)) > 64 * 1024)
      throw new HouseholdEventError("capacity_exceeded");
    // Capacity and source-identity admission have one household owner.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["household-events", identity.accountId, identity.homeId])}, 0))`,
    );
    const existing = await tx
      .select()
      .from(householdEvents)
      .where(
        and(
          within(identity),
          or(matches({ id: submission.event.id }), matches(submission)),
        ),
      )
      .limit(2);
    if (existing.length) {
      if (
        existing.length !== 1 ||
        !isDeepStrictEqual(existing[0]!.submission, submission)
      )
        throw new HouseholdEventError("conflict");
      return {
        status: "duplicate" as const,
        receipt: receipt(existing[0]!),
      };
    }
    const occurredAt = Date.parse(submission.event.occurred_at);
    const expiresAt = Date.parse(submission.event.expires_at);
    if (submission.event.source !== "agent" || expiresAt <= occurredAt)
      throw new HouseholdEventError("invalid_event");
    if (expiresAt <= Date.now()) throw new HouseholdEventError("expired");
    if (occurredAt > Date.now() + 60_000)
      throw new HouseholdEventError("future_event");
    if ((await tx.$count(householdEvents, within(identity))) >= 50_000)
      throw new HouseholdEventError("capacity_exceeded");
    assertCurrent();
    const [inserted] = await tx
      .insert(householdEvents)
      .values({
        id: submission.event.id,
        accountId: identity.accountId,
        homeId: identity.homeId ?? "",
        producerId: submission.producer_id,
        sourceEventId: submission.source_event_id,
        eventType: submission.event.event_type,
        deviceId: submission.event.device_id,
        occurredAt: new Date(submission.event.occurred_at),
        expiresAt: new Date(submission.event.expires_at),
        submission,
        acceptedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    // The UUID can also conflict with a row in a different household.
    if (!inserted) throw new HouseholdEventError("conflict");
    await validate?.(tx, submission.event);
    assertCurrent();
    return { status: "accepted" as const, receipt: receipt(inserted) };
  }
  return {
    acceptInTransaction,
    async accept(
      identity: Parameters<typeof access>[0],
      submission: ReturnType<typeof householdEventSubmissionSchema.parse>,
      assertCurrent: () => void,
      validate?: Parameters<typeof acceptInTransaction>[4],
    ) {
      return access(identity, assertCurrent, (tx) =>
        acceptInTransaction(tx, identity, submission, assertCurrent, validate),
      );
    },
    async find(
      identity: Parameters<typeof access>[0],
      key: ReturnType<typeof householdEventIdentitySchema.parse>,
      assertCurrent: () => void,
    ) {
      return access(identity, assertCurrent, async (tx) => {
        const [row] = await tx
          .select()
          .from(householdEvents)
          .where(and(within(identity), matches(key)))
          .limit(1);
        return row ? receipt(row) : null;
      });
    },
    async list(
      identity: Parameters<typeof access>[0],
      query: ReturnType<typeof householdEventQuerySchema.parse>,
      assertCurrent: () => void,
    ) {
      return access(identity, assertCurrent, async (tx) => {
        const cursor = query.cursor;
        const rows = await tx
          .select()
          .from(householdEvents)
          .where(
            and(
              within(identity),
              query.event_type
                ? eq(householdEvents.eventType, query.event_type)
                : undefined,
              query.event_types?.length
                ? inArray(householdEvents.eventType, query.event_types)
                : undefined,
              query.device_id === null
                ? isNull(householdEvents.deviceId)
                : query.device_id
                  ? eq(householdEvents.deviceId, query.device_id)
                  : undefined,
              query.occurred_from
                ? gte(householdEvents.occurredAt, new Date(query.occurred_from))
                : undefined,
              query.occurred_before
                ? lt(
                    householdEvents.occurredAt,
                    new Date(query.occurred_before),
                  )
                : undefined,
              cursor
                ? sql`(${householdEvents.acceptedAt}, ${householdEvents.id}) < (${cursor.accepted_at}::timestamptz, ${cursor.id}::uuid)`
                : undefined,
            ),
          )
          .orderBy(desc(householdEvents.acceptedAt), desc(householdEvents.id))
          .limit(query.limit + 1);
        const items = rows.slice(0, query.limit).map(receipt);
        const last = items.at(-1);
        return {
          items,
          next_cursor:
            rows.length > query.limit && last
              ? { accepted_at: last.accepted_at, id: last.event.id }
              : null,
        };
      });
    },
  };
}
