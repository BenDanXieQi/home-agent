import { eq, or } from "drizzle-orm";
import type { Database } from "../../db";
import {
  createLockedTransactions,
  lockTransaction,
  type Transaction,
} from "../../db/transaction-outcome";
import {
  spaces,
  passages,
  observationBindings,
  mijiaHomeSelections,
} from "../../db/schema";
import {
  sameSpatialScope,
  spaceSchema,
  passageSchema,
  observationBindingSchema,
  type spaceSaveSchema,
  type passageSaveSchema,
  type observationBindingSaveSchema,
  type observationBindingEnabledSchema,
  type spatialDeleteSchema,
  type spatialScopeSchema,
  type SpatialSaveOperation,
} from "@home-agent/api/spatial";
import { SpatialError } from "./errors";
import { householdBindingLock } from "../binding-repository";

function spaceRecord(row: typeof spaces.$inferSelect) {
  return spaceSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}
function passageRecord(row: typeof passages.$inferSelect) {
  return passageSchema.parse({
    ...spaceRecord(row),
    space_a_id: row.spaceAId,
    space_b_id: row.spaceBId,
  });
}
function bindingRecord(row: typeof observationBindings.$inferSelect) {
  return observationBindingSchema.parse({
    id: row.id,
    device_id: row.deviceId,
    channel: row.channel,
    space_id: row.spaceId,
    passage_id: row.passageId,
    description: row.description,
    enabled: row.enabled,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function requireVersion(
  expected: string,
  existing: Pick<typeof spaces.$inferSelect, "updatedAt"> | undefined,
) {
  if (!existing) throw new SpatialError("not_found");
  if (existing.updatedAt.toISOString() !== expected)
    throw new SpatialError("record_changed");
}
function requireOperation(
  input: SpatialSaveOperation,
  existing: Pick<typeof spaces.$inferSelect, "updatedAt"> | undefined,
) {
  if (input.operation === "create") {
    if (existing) throw new SpatialError("record_exists");
  } else requireVersion(input.expected_updated_at, existing);
}
function updatedAt(
  existing: Pick<typeof spaces.$inferSelect, "updatedAt"> | undefined,
) {
  return new Date(
    Math.max(Date.now(), (existing?.updatedAt.getTime() ?? 0) + 1),
  );
}

export function createSpatialRepository(db: Database) {
  const transaction = createLockedTransactions(db, 5000, "shared");
  async function run<T>(
    expected: ReturnType<typeof spatialScopeSchema.parse> | undefined,
    work: (
      tx: Transaction,
      scope: ReturnType<typeof spatialScopeSchema.parse>,
    ) => Promise<T>,
  ) {
    try {
      return await transaction(householdBindingLock, async (tx) => {
        const rows = await tx.select().from(mijiaHomeSelections).limit(2);
        if (rows.length > 1) throw new SpatialError("scope_changed");
        const binding = rows[0];
        const scope = binding?.homeId
          ? {
              account_id: binding.accountKey,
              home_id: binding.homeId,
              updated_at: binding.updatedAt.toISOString(),
            }
          : null;
        if (expected !== undefined && !sameSpatialScope(expected, scope))
          throw new SpatialError("scope_changed");
        await lockTransaction(
          tx,
          "spatial_configuration",
          expected === undefined ? "shared" : "exclusive",
        );
        return work(tx, scope);
      });
    } catch (cause) {
      if (cause instanceof SpatialError) throw cause;
      let detail = cause;
      while (detail instanceof Error && detail.cause instanceof Error)
        detail = detail.cause;
      if (detail instanceof Error && "code" in detail) {
        if (detail.code === "23503" || detail.code === "23514")
          throw new SpatialError("reference_invalid", { cause });
        if (detail.code === "23505")
          throw new SpatialError("record_exists", { cause });
      }
      throw new SpatialError("storage_unavailable", { cause });
    }
  }
  return {
    read() {
      return run(undefined, async (tx, scope) => ({
        scope,
        spaces: (
          await tx.select().from(spaces).orderBy(spaces.createdAt, spaces.id)
        ).map(spaceRecord),
        passages: (
          await tx
            .select()
            .from(passages)
            .orderBy(passages.createdAt, passages.id)
        ).map(passageRecord),
        observation_bindings: (
          await tx
            .select()
            .from(observationBindings)
            .orderBy(observationBindings.createdAt, observationBindings.id)
        ).map(bindingRecord),
      }));
    },
    saveSpace(input: ReturnType<typeof spaceSaveSchema.parse>) {
      return run(input.scope, async (tx) => {
        const [existing] = await tx
          .select()
          .from(spaces)
          .where(eq(spaces.id, input.id));
        requireOperation(input, existing);
        const values = {
          name: input.name,
          description: input.description,
          updatedAt: updatedAt(existing),
        };
        const [row] =
          input.operation === "create"
            ? await tx
                .insert(spaces)
                .values({
                  id: input.id,
                  createdAt: values.updatedAt,
                  ...values,
                })
                .returning()
            : await tx
                .update(spaces)
                .set(values)
                .where(eq(spaces.id, input.id))
                .returning();
        if (!row) throw new SpatialError("not_found");
        return spaceRecord(row);
      });
    },
    savePassage(input: ReturnType<typeof passageSaveSchema.parse>) {
      return run(input.scope, async (tx) => {
        const [existing] = await tx
          .select()
          .from(passages)
          .where(eq(passages.id, input.id));
        requireOperation(input, existing);
        const values = {
          name: input.name,
          description: input.description,
          spaceAId: input.space_a_id,
          spaceBId: input.space_b_id,
          updatedAt: updatedAt(existing),
        };
        const [row] =
          input.operation === "create"
            ? await tx
                .insert(passages)
                .values({
                  id: input.id,
                  createdAt: values.updatedAt,
                  ...values,
                })
                .returning()
            : await tx
                .update(passages)
                .set(values)
                .where(eq(passages.id, input.id))
                .returning();
        if (!row) throw new SpatialError("not_found");
        return passageRecord(row);
      });
    },
    saveObservationBinding(
      input: ReturnType<typeof observationBindingSaveSchema.parse>,
      checkSource: (
        existing: ReturnType<typeof bindingRecord> | undefined,
      ) => void,
    ) {
      return run(input.scope, async (tx) => {
        const [existing] = await tx
          .select()
          .from(observationBindings)
          .where(eq(observationBindings.id, input.id));
        requireOperation(input, existing);
        checkSource(existing ? bindingRecord(existing) : undefined);
        const values = {
          deviceId: input.device_id,
          channel: input.channel,
          spaceId: input.space_id,
          passageId: input.passage_id,
          description: input.description,
          enabled: input.enabled,
          updatedAt: updatedAt(existing),
        };
        const [row] =
          input.operation === "create"
            ? await tx
                .insert(observationBindings)
                .values({
                  id: input.id,
                  createdAt: values.updatedAt,
                  ...values,
                })
                .returning()
            : await tx
                .update(observationBindings)
                .set(values)
                .where(eq(observationBindings.id, input.id))
                .returning();
        if (!row) throw new SpatialError("not_found");
        return bindingRecord(row);
      });
    },
    setObservationBindingEnabled(
      input: ReturnType<typeof observationBindingEnabledSchema.parse>,
    ) {
      return run(input.scope, async (tx) => {
        const [existing] = await tx
          .select()
          .from(observationBindings)
          .where(eq(observationBindings.id, input.id));
        requireVersion(input.expected_updated_at, existing);
        const [row] = await tx
          .update(observationBindings)
          .set({ enabled: input.enabled, updatedAt: updatedAt(existing) })
          .where(eq(observationBindings.id, input.id))
          .returning();
        if (!row) throw new SpatialError("not_found");
        return bindingRecord(row);
      });
    },
    deleteSpace(input: ReturnType<typeof spatialDeleteSchema.parse>) {
      const { id } = input;
      return run(input.scope, async (tx) => {
        const [existing] = await tx
          .select({ id: spaces.id, updatedAt: spaces.updatedAt })
          .from(spaces)
          .where(eq(spaces.id, id));
        requireVersion(input.expected_updated_at, existing);
        const references = {
          passages: (
            await tx
              .select()
              .from(passages)
              .where(or(eq(passages.spaceAId, id), eq(passages.spaceBId, id)))
          ).map(passageRecord),
          observation_bindings: (
            await tx
              .select()
              .from(observationBindings)
              .where(eq(observationBindings.spaceId, id))
          ).map(bindingRecord),
        };
        if (
          references.passages.length ||
          references.observation_bindings.length
        )
          return { status: "referenced" as const, id, references };
        await tx.delete(spaces).where(eq(spaces.id, id));
        return { status: "deleted" as const, id };
      });
    },
    deletePassage(input: ReturnType<typeof spatialDeleteSchema.parse>) {
      const { id } = input;
      return run(input.scope, async (tx) => {
        const [existing] = await tx
          .select({ id: passages.id, updatedAt: passages.updatedAt })
          .from(passages)
          .where(eq(passages.id, id));
        requireVersion(input.expected_updated_at, existing);
        const bindings = (
          await tx
            .select()
            .from(observationBindings)
            .where(eq(observationBindings.passageId, id))
        ).map(bindingRecord);
        if (bindings.length)
          return {
            status: "referenced" as const,
            id,
            references: { passages: [], observation_bindings: bindings },
          };
        await tx.delete(passages).where(eq(passages.id, id));
        return { status: "deleted" as const, id };
      });
    },
    deleteObservationBinding(
      input: ReturnType<typeof spatialDeleteSchema.parse>,
    ) {
      const { id } = input;
      return run(input.scope, async (tx) => {
        const [existing] = await tx
          .select()
          .from(observationBindings)
          .where(eq(observationBindings.id, id));
        requireVersion(input.expected_updated_at, existing);
        const rows = await tx
          .delete(observationBindings)
          .where(eq(observationBindings.id, id))
          .returning({ id: observationBindings.id });
        if (!rows.length) throw new SpatialError("not_found");
        return { status: "deleted" as const, id };
      });
    },
  };
}
