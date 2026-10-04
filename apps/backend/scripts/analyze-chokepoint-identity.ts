import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import writeFileAtomic from "write-file-atomic";
import {
  identityReferenceSnapshotSchema,
  identityReferenceVersionsSchema,
  trackingObservationSchema,
  identityObservationSchema,
} from "@home-agent/api/contracts";
import { readChokePoint, hashFile } from "./perception-evaluation/chokepoint";
import { createPerceptionEnvironment } from "./perception-report";
import { createDetector } from "../src/perception/detection/detector";
import { detectionModelPath } from "../src/perception/detection/model";
import { frameSchema } from "../src/perception/detection/frame";
import { createHumanTracker } from "../src/perception/tracking/tracker";
import { createReid } from "../src/perception/tracking/reid";
import {
  reidSha256,
  reidProcessingVersion,
} from "../src/perception/tracking/feature-version";
import { createFaceModel } from "../src/perception/identity/face-model";
import { prepareIdentityFrame } from "../src/perception/identity/frame";
import { createIdentityAnalysis } from "../src/perception/identity/analysis";
import {
  identityConfigSchema,
  identityLimits,
} from "../src/perception/identity/config";
import { faceProcessingVersions } from "../src/perception/identity/processing-version";
import { createAppearanceIdentity } from "../src/household/identity/appearance";
import { appearanceEvidenceSchema } from "../src/household/identity/appearance-evidence";
import { associateMembers } from "../src/household/identity/association";
import { identityMatchingParameters } from "../src/household/identity/matching-parameters";
import faceModels from "../src/perception/identity/models.json";
import faceProfile from "../src/perception/identity/profile.json";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "model-dir": { type: "string" },
    "output-dir": { type: "string" },
  },
  strict: true,
});
if (!values["data-dir"] || !values["model-dir"] || !values["output-dir"])
  throw new Error(
    "Usage: analyze-chokepoint-identity --data-dir <fixed ChokePoint> --model-dir <fixed YuNet/SFace> --output-dir <report>",
  );
const output = resolve(values["output-dir"]);
const config = identityConfigSchema.parse({
  modelDirectory: resolve(values["model-dir"]),
});
const dataset = await readChokePoint(resolve(values["data-dir"]));
async function load(
  sample: (typeof dataset.sources)[number]["samples"][number],
) {
  const bytes = await readFile(join(dataset.imageDirectory, sample.file));
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 800 || info.height !== 600)
    throw new Error("Unexpected ChokePoint frame dimensions");
  return {
    frame: frameSchema.parse({
      width: info.width,
      height: info.height,
      rgb: new Uint8Array(data),
    }),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
function contains(
  box: { x: number; y: number; w: number; h: number },
  point: { x: number; y: number },
) {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.w &&
    point.y >= box.y &&
    point.y <= box.y + box.h
  );
}
function primaryForBox(
  sample: Parameters<typeof load>[0],
  box: Parameters<typeof contains>[0],
  scaled: boolean,
) {
  const people = sample.people.filter((person) => {
    const scale = (point: typeof person.leftEye) =>
      scaled
        ? {
            x: (point.x * faceProfile.width) / 800,
            y: (point.y * faceProfile.height) / 600,
          }
        : point;
    return (
      contains(box, scale(person.leftEye)) &&
      contains(box, scale(person.rightEye))
    );
  });
  return people.length === 1 ? people[0]!.identity : null;
}
const detector = await createDetector().catch(async (error: unknown) => {
  await dataset.close();
  throw error;
});
const face = await createFaceModel(config.modelDirectory).catch(
  async (error: unknown) => {
    try {
      await detector.close();
    } finally {
      await dataset.close();
    }
    throw error;
  },
);
const reid = await createReid().catch(async (error: unknown) => {
  try {
    await face.close();
  } finally {
    try {
      await detector.close();
    } finally {
      await dataset.close();
    }
  }
  throw error;
});
const references = new Map<
  number,
  NonNullable<Awaited<ReturnType<typeof enroll>>>
>();
const members = new Map(
  dataset.assignment.map((item) => [
    item.identity,
    { ...item, memberId: crypto.randomUUID() },
  ]),
);
const imageManifest: {
  file: string;
  sha256: string;
  phase: string;
  frameNumber: number;
  source: string;
}[] = [];
let enrollmentFaceInvocations = 0;
let targetFaceInvocations = 0;
async function enroll(
  sample: Parameters<typeof load>[0],
  registered: ReadonlySet<number>,
) {
  const image = await load(sample);
  const detections = (await detector.detect(image.frame)).detections;
  const tracker = createHumanTracker();
  const input = tracker.begin(sample.timeMs, detections);
  // Registration geometry comes from actual detection; it does not require an identity state.
  const tracks = tracker.finish(
    input,
    input.humans.map(() => null),
  );
  const prepared = await prepareIdentityFrame(
    { width: 800, height: 600, tracks },
    image.frame.rgb,
  );
  enrollmentFaceInvocations++;
  const result = await face.extract({
    kind: "tracking",
    ...prepared,
    targets: prepared.tracks.map((track) => track.trackId).slice(0, 4),
    minimumSharpness: config.minimumSharpness,
  });
  if (result.kind !== "result")
    throw new Error("Unexpected face enrollment response");
  const accepted = result.samples.flatMap((item) => {
    const identity = primaryForBox(sample, item.faceBox, true);
    const owner = members.get(identity ?? -1);
    return identity !== null && owner?.enrolled && !registered.has(identity)
      ? [
          {
            identity,
            feature: item.feature,
            sampleId: crypto.randomUUID(),
            sha256: item.cropSha256,
            sourceFile: sample.file,
            sourceSha256: image.sha256,
            frameNumber: sample.frameNumber,
            sharpness: item.sharpness,
          },
        ]
      : [];
  });
  imageManifest.push({
    file: sample.file,
    sha256: image.sha256,
    phase: "enrollment_search",
    frameNumber: sample.frameNumber,
    source: sample.source,
  });
  return accepted[0] ?? null;
}
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const quantile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: quantile(0.5),
    p95: quantile(0.95),
    max: sorted.at(-1) ?? null,
  };
}
const started = performance.now();
const cpuStart = process.cpuUsage();
let peakRss = process.memoryUsage().rss;
try {
  // Frozen enrollment rule: earliest quality-accepted C1 frame per planned enrolled identity.
  for (const sample of dataset.sources[0]!.samples) {
    if (
      !sample.people.some(
        (person) =>
          members.get(person.identity)?.enrolled &&
          !references.has(person.identity),
      )
    )
      continue;
    const reference = await enroll(sample, new Set(references.keys()));
    if (reference) references.set(reference.identity, reference);
  }
  const galleries = (["tune", "holdout"] as const).map((split) => {
    const referenceSnapshot = identityReferenceSnapshotSchema.parse({
      ...faceProcessingVersions(config.minimumSharpness),
      contentVersion: crypto.randomUUID(),
      eligibilityVersion: crypto.randomUUID(),
      matchingVersion: identityMatchingParameters.matchingVersion,
      members: [...references].flatMap(([identity, reference]) => {
        const member = members.get(identity)!;
        return reference && member.split === split
          ? [
              {
                memberId: member.memberId,
                className: "human",
                enabled: true,
                threshold: identityMatchingParameters.classes.human.threshold,
                margin: identityMatchingParameters.classes.human.margin,
                references: [
                  {
                    sampleId: reference.sampleId,
                    sha256: reference.sha256,
                    feature: reference.feature,
                  },
                ],
              },
            ]
          : [];
      }),
    });
    const names = new Map(
      [...members.values()].map((member) => [
        member.memberId,
        `ChokePoint ${member.identity}`,
      ]),
    );
    const appearance = createAppearanceIdentity({
      matching: {
        snapshot: () => referenceSnapshot,
        associate: (observation, ttl, now) =>
          associateMembers(referenceSnapshot, names, observation, ttl, now),
      },
    });
    appearance.replaceReferences(0);
    return {
      split,
      referenceSnapshot,
      appearance,
      scope: crypto.randomUUID(),
      content: new Map<string, ReturnType<typeof createIdentityAnalysis>>(),
    };
  });
  const sourceStates = dataset.sources.map((source) => ({
    source,
    tracker: createHumanTracker(),
    runId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
    sequence: 0,
    freshTimes: new Map<number, number>(),
    intervalsMs: [] as number[],
  }));
  for (const state of sourceStates)
    for (const gallery of galleries) {
      const run = {
        deviceId: `calibration:${state.source.name}`,
        channel: 1 as const,
        scopeEpoch: gallery.scope,
        runId: state.runId,
      };
      gallery.appearance.start({
        run,
        householdVersion: { scope_epoch: gallery.scope, sequence: 0 },
        maxFrameAgeMs: 2000,
        evidenceTtlMs: config.evidenceTtlMs,
        recentTtlMs: identityLimits.recentTtlMs,
        sampleFps: 3,
        modelVersion: reidSha256,
        processingVersion: reidProcessingVersion,
      });
      gallery.content.set(
        state.source.name,
        createIdentityAnalysis(config, gallery.referenceSnapshot),
      );
    }
  function record(
    sample: Parameters<typeof load>[0],
    observation: ReturnType<typeof trackingObservationSchema.parse>,
    freshTrackIds: number[],
    attemptedFaceTargets: number[],
    evidence: Extract<
      Awaited<ReturnType<typeof face.extract>>,
      { kind: "result" }
    > | null,
    outputs: {
      split: "tune" | "holdout";
      state: ReturnType<ReturnType<typeof createIdentityAnalysis>["snapshot"]>;
    }[],
  ) {
    const truthTracks = observation.tracks.flatMap((track) => {
      if (!track.measuredBox) return [];
      const identity = primaryForBox(sample, track.measuredBox, false);
      // Both eyes must have exactly one measured owner; background tracks stay unlabelled.
      if (
        identity === null ||
        observation.tracks.filter(
          (other) =>
            other.measuredBox &&
            primaryForBox(sample, other.measuredBox, false) === identity,
        ).length !== 1
      )
        return [];
      const member = members.get(identity)!;
      const value = outputs
        .find((entry) => entry.split === member.split)!
        .state.tracks.find((item) => item.trackId === track.trackId);
      const labelIdentity = value?.label
        ? ([...members.values()].find((item) => item.memberId === value.label)
            ?.identity ?? null)
        : null;
      const quality = evidence?.samples.find(
        (item) =>
          item.trackId === track.trackId &&
          primaryForBox(sample, item.faceBox, true) === identity,
      );
      const acceptedSample = value?.evidence.find(
        (item) => item.provenance.sequence === observation.sequence,
      );
      const acceptedSampleLabelIdentity = acceptedSample?.label
        ? ([...members.values()].find(
            (item) => item.memberId === acceptedSample.label,
          )?.identity ?? null)
        : null;
      const newConfirmedSupport =
        value?.state === "confirmed" &&
        quality !== undefined &&
        value.evidence.some(
          (item) =>
            item.provenance.sequence === observation.sequence &&
            item.label === value.label,
        );
      return [
        {
          trackId: track.trackId,
          identity,
          split: member.split,
          plannedEnrolled: member.enrolled,
          referenceAvailable: references.has(identity),
          state: value?.state ?? "unknown",
          labelIdentity,
          correct:
            value?.state === "confirmed" ? labelIdentity === identity : null,
          qualityAccepted: quality !== undefined,
          freshBody: freshTrackIds.includes(track.trackId),
          newConfirmedSupport,
          newConfirmedSupportWithFreshBody:
            newConfirmedSupport && freshTrackIds.includes(track.trackId),
          qualityEvidence: quality
            ? {
                cropSha256: quality.cropSha256,
                faceBox: quality.faceBox,
                sharpness: quality.sharpness,
                detectionScore: quality.detectionScore,
              }
            : null,
          acceptedNewFaceSequence: acceptedSample?.provenance.sequence ?? null,
          reason: value?.reason ?? "no_identity_track",
          supportingSamples: value?.supportingSamples ?? 0,
          acceptedNewFaceSample:
            quality !== undefined && acceptedSample !== undefined,
          acceptedSampleLabelIdentity,
          score: value?.score ?? null,
          margin: value?.margin ?? null,
        },
      ];
    });
    return {
      source: sample.source,
      sequence: observation.sequence,
      frameNumber: sample.frameNumber,
      timeMs: sample.timeMs,
      truthTracks,
      freshTargets: freshTrackIds.length,
      attemptedFaceTargets: attemptedFaceTargets.length,
      freshAttemptedFaceTargets: attemptedFaceTargets.filter((id) =>
        freshTrackIds.includes(id),
      ).length,
      qualityAcceptedTargets: evidence?.samples.length ?? 0,
      qualityAndFreshTargets:
        evidence?.samples.filter((item) => freshTrackIds.includes(item.trackId))
          .length ?? 0,
      faceQualityRejected: evidence?.qualityRejected ?? 0,
      annotatedPrimaryPeople: sample.people.length,
      unmatchedAnnotatedPrimaryPeople:
        sample.people.length - truthTracks.length,
      unlabelledMeasuredTargets:
        observation.tracks.filter((track) => track.state === "measured")
          .length - truthTracks.length,
    };
  }
  const rows: ReturnType<typeof record>[] = [];
  const selected = dataset.sources
    .flatMap((source) => source.samples)
    .toSorted((a, b) => a.frameNumber - b.frameNumber || a.camera - b.camera);
  const seenImages = new Set(
    [...references.values()].flatMap((reference) =>
      reference ? [reference.sourceSha256] : [],
    ),
  );
  let excludedReferenceWindow = 0;
  let duplicateImages = 0;
  for (const [index, sample] of selected.entries()) {
    if (
      sample.people.some((person) => {
        const reference = references.get(person.identity);
        return reference && sample.frameNumber <= reference.frameNumber + 30;
      })
    ) {
      excludedReferenceWindow++;
      continue;
    }
    const image = await load(sample);
    if (seenImages.has(image.sha256)) {
      duplicateImages++;
      continue;
    }
    seenImages.add(image.sha256);
    const state = sourceStates.find(
      (item) => item.source.name === sample.source,
    )!;
    state.sequence++;
    const detections = (await detector.detect(image.frame)).detections;
    const input = state.tracker.begin(sample.timeMs, detections);
    const features = input.cached.map((cached) => cached?.vector ?? null);
    const missing = input.humans.flatMap((_, offset) =>
      features[offset] ? [] : [offset],
    );
    if (missing.length) {
      const vectors = await reid.extract({
        frame: image.frame,
        boxes: missing.map((offset) => input.humans[offset]!),
      });
      missing.forEach((offset, vectorIndex) => {
        features[offset] = vectors[vectorIndex]!;
      });
    }
    const fresh: { trackId: number; vector: number[] }[] = [];
    const tracks = state.tracker.finish(input, features, (item) => {
      fresh.push(item);
    });
    for (const { trackId } of fresh) {
      const previous = state.freshTimes.get(trackId);
      if (previous !== undefined)
        state.intervalsMs.push(sample.timeMs - previous);
      state.freshTimes.set(trackId, sample.timeMs);
    }
    const base = {
      sequence: state.sequence,
      receivedAt: sample.timeMs,
      sampledAt: sample.timeMs,
      // These 90k ticks bind this isolated calibration's original frame, not network RTP.
      mediaTime: {
        generation: state.generation,
        pts: sample.frameNumber * 3000,
        rtpTimestamp: sample.frameNumber * 3000,
        timeBaseNumerator: 1 as const,
        timeBaseDenominator: 90000 as const,
        quality: "source_media" as const,
      },
      width: 800,
      height: 600,
      coordinateBasis: "decoded_rgb24" as const,
      ageMs: 0,
    };
    const observations = galleries.map((gallery) =>
      trackingObservationSchema.parse({
        ...base,
        run: {
          deviceId: `calibration:${sample.source}`,
          channel: 1,
          scopeEpoch: gallery.scope,
          runId: state.runId,
        },
        status: "tracked",
        skippedFrames: 0,
        omittedHumans: Math.max(
          0,
          detections.filter((item) => item.className === "human").length -
            tracks.filter((track) => track.state === "measured").length,
        ),
        omittedPets: 0,
        tracks,
      }),
    );
    const selectedTargets = galleries.map((gallery, offset) =>
      gallery.content
        .get(sample.source)!
        .observe(observations[offset]!.tracks, sample.timeMs, sample.timeMs),
    );
    const targets = [...new Set(selectedTargets.flat())].slice(0, 4);
    let evidence: Extract<
      Awaited<ReturnType<typeof face.extract>>,
      { kind: "result" }
    > | null = null;
    if (targets.length && !observations[0]!.omittedHumans) {
      const prepared = await prepareIdentityFrame(
        observations[0]!,
        image.frame.rgb,
      );
      targetFaceInvocations++;
      const result = await face.extract({
        kind: "tracking",
        ...prepared,
        targets,
        minimumSharpness: config.minimumSharpness,
      });
      if (result.kind !== "result")
        throw new Error("Unexpected tracking face response");
      evidence = result;
      for (const [offset, gallery] of galleries.entries()) {
        const analysis = gallery.content.get(sample.source)!;
        analysis.admitted(selectedTargets[offset]!, sample.timeMs);
        analysis.accept(
          result,
          observations[offset]!,
          sample.timeMs,
          sample.timeMs,
        );
      }
    } else if (observations[0]!.omittedHumans) {
      for (const gallery of galleries)
        gallery.content.get(sample.source)!.skipped("coverage");
    }
    const outputs = galleries.map((gallery, offset) => {
      const observation = observations[offset]!;
      gallery.appearance.tracking(observation, sample.timeMs);
      gallery.appearance.acceptAppearance({
        evidence: fresh.map((item) =>
          appearanceEvidenceSchema.parse({
            ...base,
            run: observation.run,
            trackId: item.trackId,
            modelVersion: reidSha256,
            processingVersion: reidProcessingVersion,
            vector: item.vector,
          }),
        ),
        householdVersion: { scope_epoch: gallery.scope, sequence: 0 },
        acceptedAt: sample.timeMs,
        remainingMs: 2000,
      });
      const analysis = gallery.content
        .get(sample.source)!
        .snapshot(sample.timeMs);
      const identity = identityObservationSchema.parse({
        ...base,
        run: observation.run,
        revision: state.sequence,
        status: "recognizing",
        referenceRevision: gallery.referenceSnapshot.contentVersion,
        referenceVersions: identityReferenceVersionsSchema.parse(
          gallery.referenceSnapshot,
        ),
        model: null,
        ...analysis,
      });
      gallery.appearance.identity(identity, sample.timeMs, sample.timeMs);
      return { split: gallery.split, state: analysis };
    });
    rows.push(
      record(
        sample,
        observations[0]!,
        fresh.map((item) => item.trackId),
        evidence ? targets : [],
        evidence,
        outputs,
      ),
    );
    imageManifest.push({
      file: sample.file,
      sha256: image.sha256,
      phase: "target",
      frameNumber: sample.frameNumber,
      source: sample.source,
    });
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if ((index + 1) % 100 === 0)
      console.log(`ChokePoint: ${index + 1}/${selected.length} source frames`);
  }
  function identityMetrics(evaluated: (typeof rows)[number]["truthTracks"]) {
    const confirmed = evaluated.filter((track) => track.state === "confirmed");
    return {
      evaluatedPrimaryTargetObservations: evaluated.length,
      correctlyMatchedNewFaceSamples: evaluated.filter(
        (track) =>
          track.acceptedNewFaceSample &&
          track.acceptedSampleLabelIdentity === track.identity,
      ).length,
      wronglyMatchedNewFaceSamples: evaluated.filter(
        (track) =>
          track.acceptedNewFaceSample &&
          track.acceptedSampleLabelIdentity !== null &&
          track.acceptedSampleLabelIdentity !== track.identity,
      ).length,
      unknownNewFaceSamples: evaluated.filter(
        (track) =>
          track.acceptedNewFaceSample &&
          track.acceptedSampleLabelIdentity === null,
      ).length,
      continuedConfirmedWithFreshBody: evaluated.filter(
        (track) =>
          track.state === "confirmed" &&
          track.freshBody &&
          !track.newConfirmedSupportWithFreshBody,
      ).length,
      confirmedErrorRate: confirmed.length
        ? confirmed.filter((track) => !track.correct).length / confirmed.length
        : null,
      reasons: [...new Set(evaluated.map((track) => track.reason))].map(
        (reason) => ({
          reason,
          count: evaluated.filter((track) => track.reason === reason).length,
        }),
      ),
      correctlyConfirmed: confirmed.filter((track) => track.correct).length,
      wronglyConfirmed: confirmed.filter((track) => !track.correct).length,
      unknown: evaluated.filter((track) => track.state === "unknown").length,
      candidate: evaluated.filter((track) => track.state === "candidate")
        .length,
      conflict: evaluated.filter((track) => track.state === "conflict").length,
      plannedEnrolledWithNoReference: evaluated.filter(
        (track) => track.plannedEnrolled && !track.referenceAvailable,
      ).length,
      qualityAcceptedPrimaryTargets: evaluated.filter(
        (track) => track.qualityAccepted,
      ).length,
      freshPrimaryTargets: evaluated.filter((track) => track.freshBody).length,
      qualityPrimaryWithFreshBody: evaluated.filter(
        (track) => track.qualityAccepted && track.freshBody,
      ).length,
      newConfirmedSupportWithFreshBody: evaluated.filter(
        (track) => track.newConfirmedSupportWithFreshBody,
      ).length,
    };
  }
  function summarize(inputRows: typeof rows, split: "tune" | "holdout") {
    const evaluated = inputRows.flatMap((row) =>
      row.truthTracks.filter((track) => track.split === split),
    );
    return {
      ...identityMetrics(evaluated),
      populations: (
        ["registered", "unregistered", "registration_unavailable"] as const
      ).map((population) => ({
        population,
        ...identityMetrics(
          evaluated.filter((track) =>
            population === "registered"
              ? track.referenceAvailable
              : population === "unregistered"
                ? !track.plannedEnrolled
                : track.plannedEnrolled && !track.referenceAvailable,
          ),
        ),
      })),
    };
  }
  const sourceReports = sourceStates.map((state) => {
    const sourceRows = rows.filter((row) => row.source === state.source.name);
    const sum = (
      key:
        | "freshTargets"
        | "attemptedFaceTargets"
        | "freshAttemptedFaceTargets"
        | "qualityAcceptedTargets"
        | "qualityAndFreshTargets"
        | "faceQualityRejected"
        | "unlabelledMeasuredTargets"
        | "annotatedPrimaryPeople"
        | "unmatchedAnnotatedPrimaryPeople",
    ) => sourceRows.reduce((total, row) => total + row[key], 0);
    return {
      name: state.source.name,
      originalImages: state.source.availableImages,
      missingOriginalImagesInSpan: state.source.missingImagesInSpan,
      availableSampledOriginalFrames: state.source.samples.length,
      unavailableSampleSlots: 441 - state.source.samples.length,
      sampledTargetFrames: sourceRows.length,
      freshTargets: sum("freshTargets"),
      xmlSha256: state.source.xmlSha256,
      attemptedFaceTargets: sum("attemptedFaceTargets"),
      freshAttemptedFaceTargets: sum("freshAttemptedFaceTargets"),
      qualityAmongAttemptedFaceRatio: sum("attemptedFaceTargets")
        ? sum("qualityAcceptedTargets") / sum("attemptedFaceTargets")
        : null,
      qualityAcceptedTargets: sum("qualityAcceptedTargets"),
      qualityAndFreshTargets: sum("qualityAndFreshTargets"),
      qualityAmongFreshRatio: sum("freshTargets")
        ? sum("qualityAndFreshTargets") / sum("freshTargets")
        : null,
      freshAmongQualityRatio: sum("qualityAcceptedTargets")
        ? sum("qualityAndFreshTargets") / sum("qualityAcceptedTargets")
        : null,
      faceQualityRejected: sum("faceQualityRejected"),
      annotatedPrimaryPeople: sum("annotatedPrimaryPeople"),
      unmatchedAnnotatedPrimaryPeople: sum("unmatchedAnnotatedPrimaryPeople"),
      unlabelledMeasuredTargets: sum("unlabelledMeasuredTargets"),
      freshIntervalsMs: distribution(state.intervalsMs),
      splits: galleries.map((gallery) => ({
        split: gallery.split,
        ...summarize(sourceRows, gallery.split),
        statistics: gallery.content.get(state.source.name)!.snapshot(147000)
          .statistics,
      })),
    };
  });
  const cpu = process.cpuUsage(cpuStart);
  const result = {
    source: {
      ...dataset.source,
      licenseNoticeSha256: createHash("sha256")
        .update(dataset.licenseNotice)
        .digest("hex"),
    },
    ...(await createPerceptionEnvironment()),
    protocol: {
      name: "isolated ChokePoint relative-frame calibration",
      sourceTime: "original filename frame / 30 fps; gaps preserved",
      realRtp: false,
      absoluteCaptureTime: false,
      binding:
        "local UUID run/scope/generation and frame*3000 binding ticks are calibration adapter metadata, never live camera evidence",
      faceConfig: {
        sampleIntervalMs: config.sampleIntervalMs,
        evidenceTtlMs: config.evidenceTtlMs,
        minimumSharpness: config.minimumSharpness,
      },
      split:
        "sha256(chokepoint-face-split:identity); first 13 tune, last 12 holdout; first 9 per split enrolled",
      referenceRule:
        "first quality-accepted primary face at a 3fps C1 original frame; one reference per enrolled identity; actual accepted face box contains both GT eyes",
      targetRule:
        "exclude each enrolled identity's frames through its reference frame +30 across all cameras; exclude duplicate/reference bytes; sample only original frame numbers divisible by10",
      faceMatching: identityMatchingParameters.classes.human,
      modelTrainingCorpusKnown: false,
      onlineCalibrated: false,
      limitations: [
        "one public indoor recording, not household acceptance",
        "GT labels primary eyes only; unlabelled backgrounds excluded from accuracy",
        "quality accepted is not confirmed; confirmation comes from production createIdentityAnalysis",
        "sample counts are correlated and not accuracy guarantees",
        "no asynchronous result/frame age or live scheduling acceptance",
        "147s input cannot validate 5/10minute TTL or clothes changes",
        "no DB/activity/UI acceptance",
      ],
    },
    assignment: [...members.values()].map(
      ({ memberId: _memberId, ...member }) => ({
        ...member,
        referenceAvailable: references.has(member.identity),
      }),
    ),
    references: [...references.values()].flatMap((reference) =>
      reference
        ? [(({ feature: _feature, ...summary }) => summary)(reference)]
        : [],
    ),
    imageManifestSha256: createHash("sha256")
      .update(JSON.stringify(imageManifest, null, 2) + "\n")
      .digest("hex"),
    excludedReferenceWindow,
    duplicateImages,
    enrollmentFaceInvocations,
    targetFaceInvocations,
    sources: sourceReports,
    appearance: galleries.map((gallery) => ({
      split: gallery.split,
      snapshot: gallery.appearance.snapshot(),
    })),
    models: {
      face: {
        yunet: faceModels.models.yunet,
        sface: faceModels.models.sface,
        ...faceProcessingVersions(config.minimumSharpness),
      },
      reid: reid.metadata,
      detectorSha256: await hashFile(detectionModelPath),
    },
    resources: {
      wallMs: performance.now() - started,
      cpuMs: (cpu.user + cpu.system) / 1000,
      sampledProcessRssPeakBytes: peakRss,
      scope:
        "enrollment/target loops only, excludes archive extraction and model startup; per-frame sampled RSS, not deployment peak",
    },
  };
  await mkdir(output, { recursive: true });
  await writeFileAtomic(
    join(output, "license-notice.html"),
    dataset.licenseNotice,
  );
  for (const [name, value] of [
    ["results.json", result],
    ["frames.json", rows],
    ["manifest.json", imageManifest],
  ] as const)
    await writeFileAtomic(
      join(output, name),
      JSON.stringify(value, null, 2) + "\n",
    );
  console.log(JSON.stringify(result, null, 2));
} finally {
  try {
    await reid.close();
  } finally {
    try {
      await face.close();
    } finally {
      try {
        await detector.close();
      } finally {
        await dataset.close();
      }
    }
  }
}
