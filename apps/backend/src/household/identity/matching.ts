import { associateMembers } from "./association";
import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import { identityClassForSubject } from "./subject";
import { identityMatchingParameters } from "./matching-parameters";
import {
  identityReferenceSnapshotSchema,
  type identityRuntimeVersionsSchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import type { Database } from "../../db";
import {
  identityFeatures,
  identityMembers,
  identityReferenceState,
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
import {
  changeReferenceVersion,
  lockIdentityMembers,
  readReferenceVersion,
} from "./repository";

/** Household-owned matching parameters and eligibility. No model execution or HTTP here. */
export function createIdentityMatching(db: Database) {
  const binding = createHouseholdBindingAccess(db);
  const transaction = createLockedTransactions(
    db,
    householdLimits.transactionMs,
    "shared",
  );
  let versions: z.infer<typeof identityRuntimeVersionsSchema> | null = null;
  let current: z.infer<typeof identityReferenceSnapshotSchema> | null = null;
  let names = new Map<string, string>();
  const listeners = new Set<() => void>();
  function install(
    next: typeof current,
    nextNames = new Map<string, string>(),
  ) {
    if (isDeepStrictEqual(next, current) && isDeepStrictEqual(names, nextNames))
      return;
    current = next;
    names = nextNames;
    for (const listener of listeners) listener();
  }
  async function configuration(tx: Transaction) {
    const state = await readReferenceVersion(tx);
    const rows = await tx
      .select({
        memberId: identityMembers.memberId,
        name: householdSubjects.name,
        kind: householdSubjects.kind,
        details: householdSubjects.details,
        enabled: identityMembers.enabled,
        sampleId: identitySamples.id,
        sha256: identitySamples.sha256,
        feature: identityFeatures.feature,
        modelVersion: identityFeatures.modelVersion,
        processingVersion: identityFeatures.processingVersion,
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
      .innerJoin(
        identityFeatures,
        eq(identityFeatures.sampleId, identitySamples.id),
      )
      .orderBy(identityMembers.memberId, identitySamples.id);
    const members = new Map<
      string,
      z.infer<typeof identityReferenceSnapshotSchema>["members"][number]
    >();
    for (const row of rows) {
      const className = identityClassForSubject(row.kind, row.details.species);
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
    const activeVersions = versions;
    const compatible =
      activeVersions !== null &&
      state.modelVersion === activeVersions.modelVersion &&
      state.processingVersion === activeVersions.processingVersion &&
      members.size > 0;
    return {
      state,
      names: new Map(
        rows
          .filter((row) => members.has(row.memberId))
          .map((row) => [row.memberId, row.name]),
      ),
      members: [...members.values()],
      compatible,
      parameters: compatible
        ? {
            ...activeVersions,
            contentVersion: state.contentVersion,
            matchingVersion: identityMatchingParameters.matchingVersion,
          }
        : null,
    };
  }
  async function refresh() {
    try {
      await transaction(householdBindingLock, async (tx) => {
        await lockIdentityMembers(tx);
        const result = await configuration(tx);
        install(
          result.parameters
            ? identityReferenceSnapshotSchema.parse({
                ...result.parameters,
                eligibilityVersion: result.state.eligibilityVersion,
                members: result.members,
              })
            : null,
          result.parameters ? result.names : new Map(),
        );
      });
    } catch (error) {
      install(null);
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
    invalidate: () => {
      install(null);
    },
    async configure(next: typeof versions) {
      install(null);
      versions = next;
      if (!next) return;
      await transaction(householdBindingLock, async (tx) => {
        await lockIdentityMembers(tx);
        const state = await readReferenceVersion(tx);
        if (
          state.modelVersion !== next.modelVersion ||
          state.processingVersion !== next.processingVersion
        ) {
          await changeReferenceVersion(tx, true);
          await tx.update(identityReferenceState).set(next);
        }
      });
      await refresh();
    },
    async read(
      identity: Parameters<typeof binding>[0],
      assertCurrent: () => void,
    ) {
      return binding(identity, assertCurrent, async (tx) => {
        await lockIdentityMembers(tx);
        return configuration(tx);
      });
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
            (!result.parameters ||
              !result.members.some((member) => member.memberId === memberId))
          )
            throw new HouseholdError("invalid_state");
          const [member] = await tx
            .select()
            .from(identityMembers)
            .where(eq(identityMembers.memberId, memberId));
          if (member && member.enabled !== enabled) {
            install(null);
            await tx
              .update(identityMembers)
              .set({ enabled })
              .where(eq(identityMembers.memberId, memberId));
            await changeReferenceVersion(tx, false);
          }
        });
      } finally {
        await refreshAfterMutation();
      }
    },
  };
}
