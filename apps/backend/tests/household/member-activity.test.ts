import { expect, spyOn, test } from "bun:test";
import {
  identityObservationSchema,
  memberAssociationSchema,
  trackingObservationSchema,
} from "@home-agent/api/contracts";
import { createDatabase } from "../../src/db";
import { HouseholdError } from "../../src/household/errors";
import { createMemberActivityRepository } from "../../src/household/identity/activity-repository";
import { createMemberActivityService } from "../../src/household/identity/activity-service";
import { createAppearanceIdentity } from "../../src/household/identity/appearance";
import { perceptionConfigSchema } from "../../src/perception/config";
import { createVideoMetrics } from "../../src/perception/video/metrics";
import { deferred, eventually } from "../support/async";
import { runningHousehold } from "../support/household-harness";

type Save = Parameters<typeof createMemberActivityService>[2]["save"];

async function activityFixture(save: Save) {
  const household = await runningHousehold();
  const run = {
    deviceId: "device-a",
    channel: 1 as const,
    scopeEpoch: household.runtime.epoch,
    runId: crypto.randomUUID(),
  };
  const memberId = crypto.randomUUID();
  const observedAt = Date.now();
  const clock = performance.now();
  const versions = {
    revision: crypto.randomUUID(),
    modelVersion: "identity-model",
    processingVersion: "identity-processing",
  };
  const tracking = trackingObservationSchema.parse({
    run,
    sequence: 1,
    receivedAt: observedAt,
    sampledAt: observedAt,
    mediaTime: {
      generation: crypto.randomUUID(),
      pts: 90000,
      rtpTimestamp: 90000,
      timeBaseNumerator: 1,
      timeBaseDenominator: 90000,
      quality: "source_media",
    },
    ageMs: 0,
    width: 640,
    height: 480,
    coordinateBasis: "decoded_rgb24",
    status: "tracked",
    skippedFrames: 0,
    omittedHumans: 0,
    omittedPets: 0,
    tracks: [
      {
        trackId: 1,
        className: "human",
        state: "measured",
        measuredBox: { x: 10, y: 10, w: 100, h: 200 },
        predictedBox: { x: 10, y: 10, w: 100, h: 200 },
        lastMeasuredAt: observedAt,
        hits: 2,
        feature: "extracted",
        featureAt: observedAt,
      },
    ],
  });
  const association = memberAssociationSchema.parse({
    run,
    sourceRunId: run.runId,
    mediaGeneration: tracking.mediaTime.generation,
    trackId: 1,
    memberId,
    memberName: "A",
    memberKind: "person",
    className: "human",
    basis: "attributes",
    state: "inferred",
    gender: "male",
    observedAt,
    expiresAt: observedAt + 30000,
    evidence: [
      {
        ...tracking,
        trackId: 1,
        measuredBox: tracking.tracks[0]!.measuredBox,
        gender: "male",
        score: 0.99,
        modelVersion: "attributes-model",
        processingVersion: "attributes-processing",
      },
    ],
  });
  const identity = identityObservationSchema.parse({
    ...tracking,
    revision: 1,
    status: "collecting",
    referenceVersions: versions,
    model: null,
    tracks: [
      {
        trackId: 1,
        state: "unknown",
        label: null,
        reason: "no_fresh_identity_sample",
        samples: 0,
        supportingSamples: 0,
        score: null,
        margin: null,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        lastEvidenceAt: observedAt,
        evidence: [],
        confirmedAt: null,
        expiresAt: null,
      },
    ],
    recent: [],
    statistics: {
      frames: 1,
      sampledFrames: 1,
      skippedBusy: 0,
      skippedNoPixels: 0,
      skippedIncompleteTracking: 0,
      acceptedSamples: 0,
      duplicateSamples: 0,
      qualityRejected: 0,
      conflicts: 0,
      tracksSeen: 1,
      confirmedTracks: 0,
      confirmationDelayMsTotal: 0,
    },
  });
  const appearance = createAppearanceIdentity({
    matching: {
      snapshot: () => ({ ...versions, members: [] }),
      associate: () => [],
    },
  });
  appearance.replaceReferences(clock);
  appearance.start({
    run,
    householdVersion: household.runtime.version(),
    sampleFps: 2,
    maxFrameAgeMs: 2000,
    evidenceTtlMs: 30000,
    recentTtlMs: 60000,
    modelVersion: "body-model",
    processingVersion: "body-processing",
  });
  appearance.tracking(tracking, clock);
  const source = {
    source: { deviceId: run.deviceId, channel: run.channel },
    run,
    tracking,
    media: {
      generation: tracking.mediaTime.generation,
      clockRate: 90000 as const,
    },
    authorizedAt: household.runtime.version(),
    audioTrackRunId: null,
    trackingValidity: "valid" as const,
    identityValidity: "valid" as const,
    identity,
    associations: [association],
    status: "running",
    error: undefined,
    validity: "valid" as const,
    observation: null,
    metrics: {
      ...createVideoMetrics().snapshot(),
      published: 1,
      firstPublicationMs: 0,
      waitingForFirstMs: 0,
      rejected: 0,
      expiredResults: 0,
      intervalMaxMs: 0,
    },
  };
  const listeners = new Set<() => void>();
  const service = createMemberActivityService(
    household.runtime,
    {
      appearance,
      referenceVersions: () => versions,
      personCandidates: () => ({ members: [{ memberId, name: "A" }] }),
      petCandidates: () => null,
      snapshot: () => ({
        sequence: 1,
        instanceId: crypto.randomUUID(),
        householdVersion: household.runtime.version(),
        status: "running",
        error: undefined,
        config: perceptionConfigSchema.parse({}),
        resources: null,
        compute: null,
        model: null,
        audio: {
          status: "disabled",
          error: undefined,
          processId: undefined,
          model: null,
          speech: undefined,
          tracks: [],
        },
        sources: [source],
        rejectedRetiredResults: 0,
      }),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    { save },
  );
  const conflict = identityObservationSchema.parse({
    ...identity,
    tracks: identity.tracks.map((track) => ({
      ...track,
      state: "conflict",
      reason: "conflicting_identity_evidence",
    })),
  });
  return {
    association,
    conflict() {
      source.identity = conflict;
      source.associations = [];
      appearance.identity(conflict, clock, observedAt);
      for (const listener of listeners) listener();
    },
    end() {
      appearance.identity(
        {
          ...conflict,
          revision: 2,
          sequence: 2,
          receivedAt: observedAt + 1000,
          tracks: [],
          recent: conflict.tracks.map((track) => ({
            ...track,
            lastSeenAt: observedAt + 1000,
            endedAt: observedAt + 1000,
          })),
        },
        clock + 1000,
        observedAt + 1000,
      );
    },
    async close() {
      try {
        await service.close(new AbortController().signal);
      } finally {
        await household.close();
      }
    },
  };
}

test.each([false, true])(
  "face conflict without a replacement revokes attribute activity through termination (write pending: %s)",
  async (pending) => {
    const started = deferred();
    const release = deferred();
    const saved: Parameters<Save>[2][] = [];
    const stale: unknown[] = [];
    let attempts = 0;
    const fixture = await activityFixture(
      async (_identity, assertCurrent, activity) => {
        if (++attempts === 1) {
          started.resolve();
          if (pending) await release.promise;
        }
        try {
          assertCurrent();
        } catch (error) {
          stale.push(error);
          throw error;
        }
        saved.push(structuredClone(activity));
        return {
          status: "saved",
          revision: activity.record.data.attribution.revision,
        };
      },
    );
    try {
      await started.promise;
      if (!pending) await eventually(() => saved.length === 1);
      fixture.conflict();
      release.resolve();
      await eventually(
        () => saved.at(-1)?.record.data.attribution.current.kind === "unknown",
      );
      fixture.end();
      await eventually(() => saved.at(-1)?.record.data.endedAt !== null);
      const attribution = saved.at(-1)!.record.data.attribution;
      expect(attribution.current).toMatchObject({
        kind: "unknown",
        reason: "target_face_conflict",
        trigger: {
          referenceIds: [],
          references: [],
          reason: "target_face_conflict",
        },
      });
      expect(attribution.original).toMatchObject({
        kind: "known",
        association: fixture.association,
      });
      expect(attribution.correctionCount).toBe(1);
      expect(attribution.lastCorrection).toMatchObject({
        reason: "target_face_conflict",
        before: { kind: "known", association: fixture.association },
        after: attribution.current,
      });
      expect(stale).toHaveLength(pending ? 1 : 0);
      if (pending) expect(stale[0]).toBeInstanceOf(HouseholdError);
    } finally {
      release.resolve();
      await fixture.close();
    }
  },
);

test("attribute conflict corrections require the same target conflict and cannot revoke references", async () => {
  const saved: Parameters<Save>[2][] = [];
  const fixture = await activityFixture(
    async (_identity, assertCurrent, activity) => {
      assertCurrent();
      saved.push(structuredClone(activity));
      return {
        status: "saved",
        revision: activity.record.data.attribution.revision,
      };
    },
  );
  const database = createDatabase("postgres://test:test@127.0.0.1:1/test");
  const repository = createMemberActivityRepository(database.db);
  const reachedStorage = new Error("Validated correction reached storage");
  const transaction = spyOn(database.db, "transaction").mockRejectedValue(
    reachedStorage,
  );
  try {
    await eventually(() => saved.length === 1);
    fixture.conflict();
    await eventually(
      () => saved.at(-1)?.record.data.attribution.current.kind === "unknown",
    );
    const corrected = saved.at(-1)!;
    const identity = { accountId: "account", homeId: "home" };
    await expect(repository.save(identity, () => {}, corrected)).rejects.toBe(
      reachedStorage,
    );
    expect(transaction).toHaveBeenCalledTimes(1);

    const wrongTarget = structuredClone(corrected);
    const current = wrongTarget.record.data.attribution.current;
    if (current.kind !== "unknown" || !current.trigger.trigger)
      throw new Error("Expected a conflict correction");
    current.trigger.trigger.track.trackId++;
    wrongTarget.record.data.attribution.lastCorrection!.after = current;
    await expect(
      repository.save(identity, () => {}, wrongTarget),
    ).rejects.toThrow("Member activity conflict target identity mismatch");

    const revoked = structuredClone(corrected);
    const revokedAttribution = revoked.record.data.attribution;
    if (revokedAttribution.current.kind !== "unknown")
      throw new Error("Expected a conflict correction");
    revokedAttribution.current.reason = "reference_revoked";
    revokedAttribution.lastCorrection!.reason = "reference_revoked";
    revokedAttribution.lastCorrection!.after = revokedAttribution.current;
    await expect(repository.save(identity, () => {}, revoked)).rejects.toThrow(
      "Member activity revocation lacks domain evidence",
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  } finally {
    transaction.mockRestore();
    await repository.close();
    await database.close();
    await fixture.close();
  }
});
