import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  identityReferenceSnapshotSchema,
  identityReferenceVersionsSchema,
  trackingObservationSchema,
  identityObservationSchema,
} from "@home-agent/api/contracts";
import { createFaceModel } from "../../src/perception/identity/face-model";
import { prepareIdentityFrame } from "../../src/perception/identity/frame";
import { createIdentityAnalysis } from "../../src/perception/identity/analysis";
import {
  identityConfigSchema,
  identityLimits,
} from "../../src/perception/identity/config";
import { faceProcessingVersions } from "../../src/perception/identity/processing-version";
import faceModels from "../../src/perception/identity/models.json";
import { identityMatchingParameters } from "../../src/household/identity/matching-parameters";
import { associateMembers } from "../../src/household/identity/association";
import { createAppearanceIdentity } from "../../src/household/identity/appearance";
import { appearanceEvidenceSchema } from "../../src/household/identity/appearance-evidence";
import {
  reidSha256,
  reidProcessingVersion,
} from "../../src/perception/tracking/feature-version";
import type { frameSchema } from "../../src/perception/detection/frame";

// Offline single-reference mode; the caller owns decoding, detection and tracking.
export async function createVideoIdentityAnalysis(
  modelDirectory: string,
  sourceName: string,
) {
  const config = identityConfigSchema.parse({ modelDirectory });
  const model = await createFaceModel(config.modelDirectory);
  const run = {
    deviceId: sourceName,
    channel: 1 as const,
    scopeEpoch: crypto.randomUUID(),
    runId: crypto.randomUUID(),
  };
  const generation = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const names = new Map([[memberId, "unique enrolled face"]]);
  let reference: ReturnType<typeof referenceSummary> | null = null;
  let gallery: z.infer<typeof identityReferenceSnapshotSchema> | null = null;
  let analysis: ReturnType<typeof createIdentityAnalysis> | null = null;
  const appearance = createAppearanceIdentity({
    matching: {
      snapshot: () => gallery,
      associate: (observation, ttl, now) =>
        associateMembers(gallery, names, observation, ttl, now),
    },
  });
  let lastClockMs = 0;
  const statistics = {
    registrationFrames: 0,
    registrationModelCalls: 0,
    registrationAmbiguousFrames: 0,
    targetFrames: 0,
    targetFreshBodyObservations: 0,
    targetFramesWithoutReference: 0,
    duplicateReferenceFrames: 0,
    faceModelCalls: 0,
    requestedFaceTargets: 0,
    qualityAcceptedTargets: 0,
    qualityWithFreshBody: 0,
    newConfirmedFaceSupports: 0,
    newConfirmedSupportWithFreshBody: 0,
    continuedConfirmedWithFreshBody: 0,
    confirmedWithReusedBody: 0,
    firstConfirmedRelativeMs: null as number | null,
    confirmedTargetObservations: 0,
    candidateTargetObservations: 0,
    unknownTargetObservations: 0,
    conflictTargetObservations: 0,
  };
  function referenceSummary(
    candidate: Extract<
      Awaited<ReturnType<typeof model.extract>>,
      { kind: "enrollment" }
    >["candidates"][number],
    input: Parameters<typeof step>[0],
    frameSha256: string,
  ) {
    return {
      sourceFrameIndex: input.sourceFrameIndex,
      sequence: input.sequence,
      localPtsMs: input.ptsMs,
      relativeMs: input.timeMs,
      frameSha256,
      cropSha256: candidate.cropSha256,
      detectionScore: candidate.detectionScore,
      sharpness: candidate.sharpness,
    };
  }
  async function step(input: {
    frame: z.infer<typeof frameSchema>;
    tracks: z.infer<typeof trackingObservationSchema>["tracks"];
    fresh: Pick<
      z.infer<typeof appearanceEvidenceSchema>,
      "trackId" | "vector"
    >[];
    timeMs: number;
    ptsMs: number;
    sourceFrameIndex: number;
    sequence: number;
    omittedHumans: number;
    omittedPets: number;
  }) {
    lastClockMs = input.timeMs;
    const frameSha256 = createHash("sha256")
      .update(input.frame.rgb)
      .digest("hex");
    const freshIds = new Set(input.fresh.map((item) => item.trackId));
    if (input.timeMs < 5000) {
      statistics.registrationFrames++;
      if (!reference) {
        const prepared = await prepareIdentityFrame(
          { ...input.frame, tracks: input.tracks },
          input.frame.rgb,
        );
        statistics.registrationModelCalls++;
        const result = await model.extract({
          kind: "video_frame",
          className: "human",
          ...prepared,
          minimumSharpness: config.minimumSharpness,
        });
        if (result.kind !== "enrollment")
          throw new Error("Unexpected registration response");
        if (result.candidates.length > 1)
          statistics.registrationAmbiguousFrames++;
        const candidate =
          result.candidates.length === 1 ? result.candidates[0] : undefined;
        if (candidate) {
          reference = referenceSummary(candidate, input, frameSha256);
          gallery = identityReferenceSnapshotSchema.parse({
            ...faceProcessingVersions(config.minimumSharpness),
            contentVersion: crypto.randomUUID(),
            eligibilityVersion: crypto.randomUUID(),
            matchingVersion: identityMatchingParameters.matchingVersion,
            members: [
              {
                memberId,
                className: "human",
                threshold: identityMatchingParameters.classes.human.threshold,
                margin: identityMatchingParameters.classes.human.margin,
                enabled: true,
                references: [
                  {
                    sampleId: crypto.randomUUID(),
                    sha256: candidate.cropSha256,
                    feature: candidate.feature,
                  },
                ],
              },
            ],
          });
          analysis = createIdentityAnalysis(config, gallery);
          appearance.replaceReferences(input.timeMs);
          appearance.start({
            run,
            householdVersion: { scope_epoch: run.scopeEpoch, sequence: 0 },
            sampleFps: 3,
            maxFrameAgeMs: 2000,
            evidenceTtlMs: config.evidenceTtlMs,
            recentTtlMs: identityLimits.recentTtlMs,
            modelVersion: reidSha256,
            processingVersion: reidProcessingVersion,
          });
        }
      }
      return {
        phase: "registration" as const,
        referenceReady: reference !== null,
        quality: [],
        identities: [],
        referencesNow: 0,
        newReferences: 0,
      };
    }
    statistics.targetFrames++;
    statistics.targetFreshBodyObservations += input.fresh.length;
    const currentGallery = gallery;
    const currentAnalysis = analysis;
    if (!reference || !currentGallery || !currentAnalysis) {
      statistics.targetFramesWithoutReference++;
      return {
        phase: "target" as const,
        referenceReady: false,
        quality: [],
        identities: [],
        referencesNow: 0,
        newReferences: 0,
      };
    }
    if (reference.frameSha256 === frameSha256) {
      statistics.duplicateReferenceFrames++;
      return {
        phase: "target" as const,
        referenceReady: true,
        quality: [],
        identities: [],
        referencesNow: appearance.snapshot().references.length,
        newReferences: 0,
      };
    }
    // File PTS supplies this calibration's frame binding; it is not network RTP.
    const ticks = Math.round(input.ptsMs * 90);
    const observation = trackingObservationSchema.parse({
      run,
      sequence: input.sequence,
      receivedAt: input.timeMs,
      sampledAt: input.timeMs,
      ageMs: 0,
      width: input.frame.width,
      height: input.frame.height,
      coordinateBasis: "decoded_rgb24",
      mediaTime: {
        generation,
        pts: ticks,
        rtpTimestamp: ticks,
        timeBaseNumerator: 1,
        timeBaseDenominator: 90000,
        quality: "source_media",
      },
      status: "tracked",
      skippedFrames: 0,
      omittedHumans: input.omittedHumans,
      omittedPets: input.omittedPets,
      tracks: input.tracks,
    });
    const targets = currentAnalysis.observe(
      input.tracks,
      input.timeMs,
      input.timeMs,
    );
    let evidence: Extract<
      Awaited<ReturnType<typeof model.extract>>,
      { kind: "result" }
    > | null = null;
    if (targets.length && !input.omittedHumans && !input.omittedPets) {
      const prepared = await prepareIdentityFrame(observation, input.frame.rgb);
      statistics.faceModelCalls++;
      statistics.requestedFaceTargets += targets.length;
      const result = await model.extract({
        kind: "tracking",
        ...prepared,
        targets,
        minimumSharpness: config.minimumSharpness,
      });
      if (result.kind !== "result")
        throw new Error("Unexpected face tracking response");
      evidence = result;
      currentAnalysis.admitted(targets, input.timeMs);
      currentAnalysis.accept(result, observation, input.timeMs, input.timeMs);
      statistics.qualityAcceptedTargets += result.samples.length;
      statistics.qualityWithFreshBody += result.samples.filter((item) =>
        freshIds.has(item.trackId),
      ).length;
    } else if (input.omittedHumans || input.omittedPets)
      currentAnalysis.skipped("coverage");
    const before = appearance.snapshot().statistics.referencesCreated;
    appearance.tracking(observation, input.timeMs);
    appearance.acceptAppearance({
      evidence: input.fresh.map((item) =>
        appearanceEvidenceSchema.parse({
          ...observation,
          trackId: item.trackId,
          vector: item.vector,
          modelVersion: reidSha256,
          processingVersion: reidProcessingVersion,
        }),
      ),
      householdVersion: { scope_epoch: run.scopeEpoch, sequence: 0 },
      acceptedAt: input.timeMs,
      remainingMs: 2000,
    });
    const state = currentAnalysis.snapshot(input.timeMs);
    appearance.identity(
      identityObservationSchema.parse({
        ...observation,
        revision: input.sequence,
        status: "recognizing",
        referenceRevision: currentGallery.contentVersion,
        referenceVersions:
          identityReferenceVersionsSchema.parse(currentGallery),
        model: null,
        ...state,
      }),
      input.timeMs,
      input.timeMs,
    );
    const identities = state.tracks.map((track) => {
      const sample = evidence?.samples.find(
        (item) => item.trackId === track.trackId,
      );
      const accepted = track.evidence.find(
        (item) => item.provenance.sequence === input.sequence,
      );
      const newConfirmedSupport =
        track.state === "confirmed" &&
        sample !== undefined &&
        accepted !== undefined &&
        accepted.label === track.label;
      const freshBody = freshIds.has(track.trackId);
      const newConfirmedSupportWithFreshBody = newConfirmedSupport && freshBody;
      if (track.state === "confirmed") {
        statistics.confirmedTargetObservations++;
        statistics.firstConfirmedRelativeMs ??= input.timeMs;
        if (newConfirmedSupport) statistics.newConfirmedFaceSupports++;
        if (newConfirmedSupportWithFreshBody)
          statistics.newConfirmedSupportWithFreshBody++;
        if (freshBody && !newConfirmedSupport)
          statistics.continuedConfirmedWithFreshBody++;
        if (
          input.tracks.some(
            (body) =>
              body.trackId === track.trackId && body.feature === "reused",
          )
        )
          statistics.confirmedWithReusedBody++;
      } else if (track.state === "candidate")
        statistics.candidateTargetObservations++;
      else if (track.state === "conflict")
        statistics.conflictTargetObservations++;
      else statistics.unknownTargetObservations++;
      return {
        trackId: track.trackId,
        state: track.state,
        matchesEnrolledReference: track.label === memberId,
        reason: track.reason,
        supportingSamples: track.supportingSamples,
        score: track.score,
        margin: track.margin,
        freshBody,
        acceptedNewFaceSequence: accepted?.provenance.sequence ?? null,
        newConfirmedSupport,
        newConfirmedSupportWithFreshBody,
        support: track.evidence.map((item) => ({
          sequence: item.provenance.sequence,
          localBindingTicks: item.provenance.rtpTimestamp,
          observedAtRelativeMs: item.observedAt,
          matchesEnrolledReference: item.label === memberId,
          score: item.score,
        })),
      };
    });
    const domain = appearance.snapshot();
    return {
      phase: "target" as const,
      referenceReady: true,
      quality:
        evidence?.samples.map(({ feature: _feature, ...sample }) => sample) ??
        [],
      identities,
      referencesNow: domain.references.length,
      newReferences: domain.statistics.referencesCreated - before,
    };
  }
  return {
    step,
    snapshot() {
      const state = analysis?.snapshot(lastClockMs) ?? null;
      return {
        protocol: {
          registrationWindowMs: 5000,
          referenceRule:
            "first unique quality-accepted face in the prefix; target window begins at5s",
          targetTruth:
            "no per-frame identity GT; output means matching the observed single reference, not participant identity accuracy",
          realRtp: false,
          absoluteCaptureTime: false,
          binding:
            "local PTS converted to isolated 90k binding ticks; never a camera RTP claim",
          synchronousOfflineDelivery: true,
          onlineAppearanceCalibrated: false,
          faceConfig: {
            sampleIntervalMs: config.sampleIntervalMs,
            evidenceTtlMs: config.evidenceTtlMs,
            minimumSharpness: config.minimumSharpness,
          },
          matching: identityMatchingParameters.classes.human,
        },
        reference,
        statistics: { ...statistics },
        analysisStatistics: state?.statistics ?? null,
        appearance: appearance.snapshot(),
        models: {
          yunet: faceModels.models.yunet,
          sface: faceModels.models.sface,
          ...faceProcessingVersions(config.minimumSharpness),
        },
        limitations: [
          "single reference/one public scene; no independent identity holdout or multi-person error rate",
          "role mapping is not per-frame identity GT",
          "no asynchronous latency, live frame-age or household/database/UI acceptance",
          "30s cannot calibrate1/5/10minute TTL; no inferred activity output",
        ],
      };
    },
    close: () => model.close(),
  };
}
