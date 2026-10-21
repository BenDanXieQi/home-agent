import {
  identityReferenceSnapshotSchema,
  type identityRuntimeVersionsSchema,
} from "./contracts";
import { associateMembers } from "./association";
import { isDeepStrictEqual } from "node:util";
import { eq, sql } from "drizzle-orm";
import { identityClassForSubject, personGenderForSubject } from "./subject";
import type { personGenderSchema } from "@home-agent/api/household-members";
import { identityMatchingParameters } from "./matching-parameters";

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
  let people: Awaited<ReturnType<typeof configuration>>["people"] | null = null;
  const listeners = new Set<() => void>();
  function install(
    next: typeof current,
    nextNames = new Map<string, string>(),
    nextPets: typeof pets = null,
    nextPeople: typeof people = null,
  ) {
    if (
      isDeepStrictEqual(next, current) &&
      isDeepStrictEqual(names, nextNames) &&
      isDeepStrictEqual(pets, nextPets) &&
      isDeepStrictEqual(people, nextPeople)
    )
      return;
    current = next;
    names = nextNames;
    pets = nextPets;
    people = nextPeople;
    for (const listener of listeners) listener();
  }
  function invalidate() {
    revision = crypto.randomUUID();
    install(null);
  }
  function referenceFeatures(
    className: z.infer<
      typeof identityReferenceSnapshotSchema
    >["members"][number]["className"],
    sample: Pick<
      typeof identitySamples.$inferSelect,
      "feature" | "appearance" | "modelVersion" | "processingVersion"
    >,
  ) {
    const expected = versions?.adapters[className];
    return [
      ...(expected &&
      sample.feature &&
      sample.modelVersion === expected.modelVersion &&
      sample.processingVersion === expected.processingVersion &&
      sample.feature.length ===
        identityMatchingParameters.classes[className].featureDimensions
        ? [className === "human" ? ("face" as const) : ("pet" as const)]
        : []),
      ...(expected &&
      className === "human" &&
      sample.appearance?.modelVersion === versions?.appearance.modelVersion &&
      sample.appearance?.processingVersion ===
        versions?.appearance.processingVersion
        ? ["body" as const]
        : []),
    ];
  }
  async function configuration(tx: Transaction) {
    const subjects = await tx
      .select({
        id: householdSubjects.id,
        name: householdSubjects.name,
        kind: householdSubjects.kind,
        gender: sql`${householdSubjects.details}->>'gender'`,
        species: sql`${householdSubjects.details}->>'species'`,
      })
      .from(householdSubjects)
      .orderBy(householdSubjects.id);
    const petMembers = subjects.flatMap((subject) => {
      const className = identityClassForSubject(subject.kind, subject.species);
      return className === "cat" || className === "dog"
        ? [{ memberId: subject.id, name: subject.name, className }]
        : [];
    });
    const petInventory = {
      membersByClass: Map.groupBy(petMembers, (member) => member.className),
    };
    const personMembers = subjects.flatMap((subject) => {
      const gender = personGenderForSubject(subject.gender);
      return subject.kind === "person" && gender
        ? [{ memberId: subject.id, name: subject.name, gender }]
        : [];
    });
    const peopleByGender = Map.groupBy(
      personMembers,
      (member) => member.gender,
    );
    const attributeGenders = [...peopleByGender]
      .filter(([, members]) => members.length === 1)
      .map(([gender]) => gender);
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
        appearance: identitySamples.appearance,
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
      const parameters = identityMatchingParameters.classes[className];
      if (
        !row.feature ||
        !referenceFeatures(className, row).includes(
          className === "human" ? "face" : "pet",
        )
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
    const appearanceSamples = rows.filter(
      (row) =>
        row.kind === "person" &&
        referenceFeatures("human", row).includes("body"),
    );
    const appearanceReferences = appearanceSamples
      .filter((row) => row.enabled)
      .map((row) => ({
        sampleId: row.sampleId,
        memberId: row.memberId,
        sha256: row.sha256,
        ...row.appearance!,
      }));
    return {
      pets: petInventory,
      people: peopleByGender,
      eligibleMembers: new Set([
        ...members.keys(),
        ...appearanceSamples.map((row) => row.memberId),
      ]),
      names: new Map(rows.map((row) => [row.memberId, row.name])),
      snapshot:
        versions &&
        (members.size || attributeGenders.length || appearanceReferences.length)
          ? identityReferenceSnapshotSchema.parse({
              ...versions,
              revision,
              attributeGenders,
              appearanceReferences,
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
          result.people,
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
      console.error(
        "Identity matching revoked after reference refresh failed",
        error,
      );
    }
  }
  return {
    referenceFeatures,
    personCandidates(gender: z.infer<typeof personGenderSchema>) {
      const members = people?.get(gender);
      return people && members?.length
        ? { members: members.map(({ memberId, name }) => ({ memberId, name })) }
        : null;
    },
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
      const body = current?.appearanceReferences?.some(
        (reference) => reference.memberId === memberId,
      );
      const name = names.get(memberId);
      return (member || body) && name !== undefined
        ? { memberId, className: member?.className ?? ("human" as const), name }
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
    appearanceVersions() {
      return versions?.appearance ?? null;
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
          if (enabled && !result.eligibleMembers.has(memberId))
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
