import { identityClassForSubject } from "./subject";
import { identityMatchingParameters } from "./matching-parameters";
import { createIdentityMatching } from "./matching";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { identityCapacity } from "@home-agent/api/contracts";
import type { z } from "zod";
import type { Database } from "../../db";
import { createLockedTransactions } from "../../db/transaction-outcome";
import {
  householdSubjects,
  identityMembers,
  identitySamples,
} from "../../db/schema";
import {
  createHouseholdBindingAccess,
  householdBindingLock,
} from "../binding-repository";
import { householdLimits } from "../config";
import { HouseholdError } from "../errors";
import { referenceInputSchema, referenceStorageLimits } from "./contracts";
import type { createReferenceFiles } from "./files";
import { lockIdentityMembers } from "./repository";

/** Owns reference storage, not image extraction, matching, or HTTP. */
export function createIdentityReferences(
  db: Database,
  files: ReturnType<typeof createReferenceFiles>,
) {
  const matching = createIdentityMatching(db);
  const binding = createHouseholdBindingAccess(db);
  const transaction = createLockedTransactions(
    db,
    householdLimits.transactionMs,
    "shared",
  );
  const cleanup = async () => {
    // Capture candidates before taking the lock. A writer creates its file
    // under that lock, so reacquiring it settles the candidate's DB ownership.
    // Keys are never reused: deletion can safely happen after releasing locks.
    const candidates = await files.listKeys();
    if (!candidates.length) return;
    const unreferenced = await transaction(householdBindingLock, async (tx) => {
      await lockIdentityMembers(tx);
      const rows = await tx
        .select({ key: identitySamples.imageKey })
        .from(identitySamples);
      const referenced = new Set(rows.map((row) => row.key));
      return candidates.filter((key) => !referenced.has(key));
    });
    await files.remove(unreferenced);
  };
  // Cleanup never turns a committed deletion into a reported rollback. Orphans
  // remain inaccessible and are retried at startup and after the next mutation.
  async function cleanupAfterMutation() {
    try {
      await matching.refresh();
    } catch (error) {
      console.error(
        "Identity matching revoked after storage refresh failed",
        error,
      );
    }
    try {
      await cleanup();
    } catch (error) {
      console.error(
        "Identity reference file cleanup failed; will retry",
        error,
      );
    }
  }
  async function access<T>(
    identity: Parameters<typeof binding>[0],
    assertCurrent: () => void,
    memberId: string,
    run: (
      tx: Parameters<Parameters<typeof binding>[2]>[0],
      member: typeof householdSubjects.$inferSelect,
    ) => Promise<T>,
  ) {
    return binding(identity, assertCurrent, async (tx) => {
      await lockIdentityMembers(tx);
      const [member] = await tx
        .select()
        .from(householdSubjects)
        .where(eq(householdSubjects.id, memberId));
      if (!member || (member.kind !== "person" && member.kind !== "pet"))
        throw new HouseholdError("invalid_state");
      return run(tx, member);
    });
  }
  return {
    matching,
    cleanup: cleanupAfterMutation,
    async list(
      identity: Parameters<typeof binding>[0],
      assertCurrent: () => void,
      memberId: string,
    ) {
      return access(identity, assertCurrent, memberId, async (tx, member) => {
        const [eligibility] = await tx
          .select()
          .from(identityMembers)
          .where(eq(identityMembers.memberId, memberId));
        const samples = await tx
          .select({
            id: identitySamples.id,
            sha256: identitySamples.sha256,
            source: identitySamples.source,
            quality: identitySamples.quality,
            createdAt: identitySamples.createdAt,
          })
          .from(identitySamples)
          .where(eq(identitySamples.memberId, memberId))
          .orderBy(identitySamples.createdAt, identitySamples.id);
        return {
          kind: member.kind,
          className: identityClassForSubject(
            member.kind,
            member.details.species,
          ),
          enabled: eligibility?.enabled ?? false,
          samples,
        };
      });
    },
    async save(
      identity: Parameters<typeof binding>[0],
      assertCurrent: () => void,
      input: {
        reference: z.infer<typeof referenceInputSchema>;
        image: Uint8Array;
      }[],
    ) {
      assertCurrent();
      if (!input.length || input.length > identityCapacity.referencesPerMember)
        throw new HouseholdError("capacity_exceeded");
      const samples = input.map(({ reference, image }) => {
        const data = referenceInputSchema.parse(reference);
        if (
          !image.byteLength ||
          image.byteLength > referenceStorageLimits.imageBytes
        )
          throw new HouseholdError("capacity_exceeded");
        const bytes = Buffer.from(image);
        return {
          data,
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          id: crypto.randomUUID(),
          imageKey: crypto.randomUUID(),
        };
      });
      const memberId = samples[0]!.data.memberId;
      if (
        samples.some((sample) => sample.data.memberId !== memberId) ||
        new Set(samples.map((sample) => sample.sha256)).size !== samples.length
      )
        throw new HouseholdError("invalid_state");
      await cleanup();
      try {
        return await access(
          identity,
          assertCurrent,
          memberId,
          async (tx, member) => {
            const className = identityClassForSubject(
              member.kind,
              member.details.species,
            );
            const expected = className && matching.referenceVersions(className);
            if (
              !className ||
              !expected ||
              samples.some(
                ({ data }) =>
                  data.modelVersion !== expected.modelVersion ||
                  data.processingVersion !== expected.processingVersion ||
                  data.feature.length !==
                    identityMatchingParameters.classes[className]
                      .featureDimensions,
              )
            )
              throw new HouseholdError("invalid_state");
            const all = await tx
              .select({
                memberId: identitySamples.memberId,
                sha256: identitySamples.sha256,
                imageBytes: identitySamples.imageBytes,
              })
              .from(identitySamples);
            const own = all.filter((sample) => sample.memberId === memberId);
            if (
              samples.some((sample) =>
                own.some((saved) => saved.sha256 === sample.sha256),
              )
            )
              throw new HouseholdError("invalid_state");
            if (
              own.length + samples.length >
                identityCapacity.referencesPerMember ||
              (!own.length &&
                new Set(all.map((sample) => sample.memberId)).size >=
                  identityCapacity.members) ||
              all.reduce((sum, sample) => sum + sample.imageBytes, 0) +
                samples.reduce(
                  (sum, sample) => sum + sample.bytes.byteLength,
                  0,
                ) >
                referenceStorageLimits.totalBytes
            )
              throw new HouseholdError("capacity_exceeded");
            for (const sample of samples) {
              await files.write(sample.imageKey, sample.bytes);
              assertCurrent();
            }
            matching.invalidate();
            await tx
              .insert(identityMembers)
              .values({ memberId, enabled: true })
              .onConflictDoUpdate({
                target: identityMembers.memberId,
                set: { enabled: true },
              });
            await tx.insert(identitySamples).values(
              samples.map(({ id, data, bytes, imageKey, sha256 }) => ({
                id,
                memberId,
                imageKey,
                imageBytes: bytes.byteLength,
                contentType: data.contentType,
                sha256,
                source: data.source,
                quality: data.quality,
                modelVersion: data.modelVersion,
                processingVersion: data.processingVersion,
                feature: data.feature,
              })),
            );
            return {
              count: samples.length,
            };
          },
        );
      } finally {
        await cleanupAfterMutation();
      }
    },
    async readImage(
      identity: Parameters<typeof binding>[0],
      assertCurrent: () => void,
      memberId: string,
      sampleId: string,
    ) {
      return access(identity, assertCurrent, memberId, async (tx) => {
        const [sample] = await tx
          .select({
            imageKey: identitySamples.imageKey,
            imageBytes: identitySamples.imageBytes,
            sha256: identitySamples.sha256,
            contentType: identitySamples.contentType,
          })
          .from(identitySamples)
          .where(
            and(
              eq(identitySamples.memberId, memberId),
              eq(identitySamples.id, sampleId),
            ),
          );
        if (!sample) throw new HouseholdError("invalid_state");
        const bytes = await files.read(sample.imageKey, sample.imageBytes);
        if (createHash("sha256").update(bytes).digest("hex") !== sample.sha256)
          throw new HouseholdError("home_storage");
        return { bytes, contentType: sample.contentType };
      });
    },
    async remove(
      identity: Parameters<typeof binding>[0],
      assertCurrent: () => void,
      memberId: string,
      sampleId: string,
    ) {
      try {
        return await access(identity, assertCurrent, memberId, async (tx) => {
          const removed = await tx
            .delete(identitySamples)
            .where(
              and(
                eq(identitySamples.memberId, memberId),
                eq(identitySamples.id, sampleId),
              ),
            )
            .returning({ id: identitySamples.id });
          if (removed.length) {
            if (
              (await tx.$count(
                identitySamples,
                eq(identitySamples.memberId, memberId),
              )) === 0
            )
              await tx
                .update(identityMembers)
                .set({ enabled: false })
                .where(eq(identityMembers.memberId, memberId));
            matching.invalidate();
          }
        });
      } finally {
        await cleanupAfterMutation();
      }
    },
  };
}
