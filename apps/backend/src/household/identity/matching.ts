import { associateMembers } from "./association";
import { isDeepStrictEqual } from "node:util";
import { eq, sql } from "drizzle-orm";
import { identityClassForSubject } from "./subject";
import { identityMatchingParameters } from "./matching-parameters";
import {
  identityReferenceSnapshotSchema,
  type identityRuntimeVersionsSchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import type { Database } from "../../db";
import {
  identityMembers,
  identitySamples,
  householdSubjects,
} from "../../db/schema";
import {
  createLockedTransactions,
  type Transaction,
} from "../../db/transaction-outcome";
import {
  createHouseholdBindingAccess,
  householdBindingLock,
} from "../binding-repository";
import { householdLimits } from "../config";
import { HouseholdError } from "../errors";
import { lockIdentityMembers } from "./repository";

/** Household-owned matching parameters and eligibility. No model execution or HTTP here. */
export function createIdentityMatching(db: Database) {
  const binding = createHouseholdBindingAccess(db);
  const transaction = createLockedTransactions(
    db,
    householdLimits.transactionMs,
    "shared",
  );
  let versions: z.infer<typeof identityRuntimeVersionsSchema> | null = null;
  let revision = crypto.randomUUID();
  let current: z.infer<typeof identityReferenceSnapshotSchema> | null = null;
  let names = new Map<string, string>();
  let pets: Awaited<ReturnType<typeof configuration>>["pets"] | null = null;
  const listeners = new Set<() => void>();
  function install(
    next: typeof current,
    nextNames = new Map<string, string>(),
    nextPets: typeof pets = null,
  ) {
    if (
      isDeepStrictEqual(next, current) &&
      isDeepStrictEqual(names, nextNames) &&
      isDeepStrictEqual(pets, nextPets)
    )
      return;
    current = next;
    names = nextNames;
    pets = nextPets;
    for (const listener of listeners) listener();
  }
  // One backend owns live evidence. A revoked snapshot never regains its revision.
  function invalidate() {
    revision = crypto.randomUUID();
    install(null);
  }
  async function configuration(tx: Transaction) {
    const subjects = await tx
      .select({
        id: householdSubjects.id,
        name: householdSubjects.name,
        species: sql`${householdSubjects.details}->>'species'`,
      })
      .from(householdSubjects)
      .where(eq(householdSubjects.kind, "pet"))
      .orderBy(householdSubjects.id);
    const petMembers = subjects.flatMap((subject) => {
      const className = identityClassForSubject("pet", subject.species);
      return className === "cat" || className === "dog"
        ? [{ memberId: subject.id, name: subject.name, className }]
        : [];
    });
    const petInventory = {
      membersByClass: Map.groupBy(petMembers, (member) => member.className),
    };
    const rows = await tx
      .select({
        memberId: identityMembers.memberId,
        name: householdSubjects.name,
        kind: householdSubjects.kind,
        species: sql`${householdSubjects.details}->>'species'`,
        enabled: identityMembers.enabled,
        sampleId: identitySamples.id,
        sha256: identitySamples.sha256,
        feature: identitySamples.feature,
        modelVersion: identitySamples.modelVersion,
        processingVersion: identitySamples.processingVersion,
      })
      .from(identityMembers)
      .innerJoin(
        householdSubjects,
        eq(householdSubjects.id, identityMembers.memberId),
      )
      .innerJoin(
        identitySamples,
        eq(identitySamples.memberId, identityMembers.memberId),
      )
      .orderBy(identityMembers.memberId, identitySamples.id);
    const members = new Map<
      string,
      z.infer<typeof identityReferenceSnapshotSchema>["members"][number]
    >();
    for (const row of rows) {
      const className = identityClassForSubject(row.kind, row.species);
      if (!className || !versions) continue;
      const expected = versions.adapters[className];
      const parameters = identityMatchingParameters.classes[className];
      if (
        row.modelVersion !== expected.modelVersion ||
        row.processingVersion !== expected.processingVersion ||
        row.feature.length !== parameters.featureDimensions
      )
        continue;
      const member = members.get(row.memberId) ?? {
        memberId: row.memberId,
        className,
        threshold: parameters.threshold,
        margin: parameters.margin,
        enabled: row.enabled,
        references: [],
      };
      member.references.push({
        sampleId: row.sampleId,
        sha256: row.sha256,
        feature: row.feature,
      });
      members.set(row.memberId, member);
    }
    return {
      pets: petInventory,
      names: new Map(
        rows
          .filter((row) => members.has(row.memberId))
          .map((row) => [row.memberId, row.name]),
      ),
      snapshot:
        versions && members.size
          ? identityReferenceSnapshotSchema.parse({
              ...versions,
              revision,
              members: [...members.values()],
            })
          : null,
    };
  }
  async function refresh(next?: typeof versions) {
    try {
      await transaction(householdBindingLock, async (tx) => {
        await lockIdentityMembers(tx);
        if (next !== undefined && !isDeepStrictEqual(versions, next)) {
          invalidate();
          versions = next;
        }
        const result = await configuration(tx);
        install(
          result.snapshot,
          result.snapshot ? result.names : new Map(),
          result.pets,
        );
      });
    } catch (error) {
      invalidate();
      throw error;
    }
  }
  async function refreshAfterMutation() {
    try {
      await refresh();
    } catch (error) {
      // refresh already revoked matching. Preserve the transaction's outcome:
      // a failed read must not turn a committed write into a reported failure.
      console.error(
        "Identity matching revoked after reference refresh failed",
        error,
      );
    }
  }
  return {
    petCandidates(className: "cat" | "dog") {
      const members = pets?.membersByClass.get(className);
      return pets && members?.length
        ? {
            members: members.map(({ memberId, name }) => ({ memberId, name })),
          }
        : null;
    },
    member(memberId: string) {
      const member = current?.members.find(
        (item) => item.memberId === memberId && item.enabled,
      );
      const name = names.get(memberId);
      return member && name !== undefined
        ? { memberId, className: member.className, name }
        : null;
    },
    associate(
      observation: Parameters<typeof associateMembers>[2],
      evidenceTtlMs: number,
      now: number,
    ) {
      return associateMembers(current, names, observation, evidenceTtlMs, now);
    },
    referenceVersions(
      className: z.infer<
        typeof identityReferenceSnapshotSchema
      >["members"][number]["className"],
    ) {
      return versions?.adapters[className] ?? null;
    },
    snapshot: () => (current === null ? null : structuredClone(current)),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    invalidate,
    configure(next: typeof versions) {
      return refresh(next);
    },
    async toggle(
      identity: Parameters<typeof binding>[0],
      assertCurrent: () => void,
      memberId: string,
      enabled: boolean,
    ) {
      try {
        await binding(identity, assertCurrent, async (tx) => {
          await lockIdentityMembers(tx);
          const result = await configuration(tx);
          if (
            enabled &&
            (!result.snapshot ||
              !result.snapshot.members.some(
                (member) => member.memberId === memberId,
              ))
          )
            throw new HouseholdError("invalid_state");
          const [member] = await tx
            .select()
            .from(identityMembers)
            .where(eq(identityMembers.memberId, memberId));
          if (member && member.enabled !== enabled) {
            invalidate();
            await tx
              .update(identityMembers)
              .set({ enabled })
              .where(eq(identityMembers.memberId, memberId));
          }
        });
      } finally {
        await refreshAfterMutation();
      }
    },
  };
}
