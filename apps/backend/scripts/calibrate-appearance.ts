import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import writeFileAtomic from "write-file-atomic";
import { appearanceScore } from "../src/household/identity/appearance-score";
import { createReid } from "../src/perception/tracking/reid";
import { reidProcessingVersion } from "../src/perception/tracking/feature-version";
import { frameLimits, frameSchema } from "../src/perception/detection/frame";
import { createPerceptionEnvironment } from "./perception-report";
import { fingerprint, readReal28 } from "./perception-evaluation/real28";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "output-dir": { type: "string" },
  },
  strict: true,
});
if (!values["data-dir"] || !values["output-dir"])
  throw new Error(
    "Usage: calibrate-appearance --data-dir <fixed Real28 release> --output-dir <report>",
  );
const directory = resolve(values["data-dir"]);
const output = resolve(values["output-dir"]);
const dataset = await readReal28(directory);
const model = await createReid().catch(async (error: unknown) => {
  await dataset.close();
  throw error;
});
async function extractSample(
  sample: (typeof dataset.samples)[number],
  bytes: Uint8Array,
  sha256: string,
) {
  const { data, info } = await sharp(bytes, {
    limitInputPixels: frameLimits.maxPixels,
  })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const frame = frameSchema.parse({
    width: info.width,
    height: info.height,
    rgb: new Uint8Array(data),
  });
  const [vector] = await model.extract({
    frame,
    boxes: [
      {
        x: 0,
        y: 0,
        w: frame.width,
        h: frame.height,
        classId: 0,
        className: "human",
        confidence: 1,
      },
    ],
  });
  if (!vector) throw new Error(`No feature for ${sample.file}`);
  return {
    ...sample,
    sha256,
    width: info.width,
    height: info.height,
    vector,
  };
}

const features: Awaited<ReturnType<typeof extractSample>>[] = [];
const seen = new Map<string, (typeof dataset.samples)[number]>();
const duplicates: { file: string; duplicateOf: string; sha256: string }[] = [];
const durations: number[] = [];
let peakRss = process.memoryUsage().rss;
const started = performance.now();
const cpuStart = process.cpuUsage();
try {
  // References are processed first so duplicate bytes cannot leak into targets.
  const samples = dataset.samples.toSorted(
    (a, b) =>
      (a.role === "reference" ? 0 : 1) - (b.role === "reference" ? 0 : 1) ||
      a.file.localeCompare(b.file),
  );
  for (const [index, sample] of samples.entries()) {
    const bytes = await readFile(join(dataset.imageDirectory, sample.file));
    const sha256 = fingerprint(bytes);
    const duplicate = seen.get(sha256);
    if (duplicate) {
      if (
        duplicate.identity !== sample.identity ||
        duplicate.clothing !== sample.clothing
      )
        throw new Error(
          `Conflicting labels for identical image bytes: ${sample.file}`,
        );
      duplicates.push({
        file: sample.file,
        duplicateOf: duplicate.file,
        sha256,
      });
      continue;
    }
    seen.set(sha256, sample);
    const at = performance.now();
    features.push(await extractSample(sample, bytes, sha256));
    durations.push(performance.now() - at);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if ((index + 1) % 500 === 0)
      console.log(`Real28: ${index + 1}/${samples.length} images`);
  }
} finally {
  try {
    await model.close();
  } finally {
    await dataset.close();
  }
}

function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const quantile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p05: quantile(0.05),
    p50: quantile(0.5),
    p95: quantile(0.95),
    max: sorted.at(-1) ?? null,
  };
}

function scoreTarget(
  target: (typeof features)[number],
  references: typeof features,
  cameraScope: "all" | "same_camera" | "other_camera",
) {
  const scores = references.map((reference) => ({
    identity: reference.identity,
    camera: reference.camera,
    clothing: reference.clothing,
    file: reference.file,
    score: appearanceScore(target.vector, reference.vector),
  }));
  const byIdentity = new Map<number, number>();
  for (const reference of scores)
    byIdentity.set(
      reference.identity,
      Math.max(byIdentity.get(reference.identity) ?? -1, reference.score),
    );
  const ranked = [...byIdentity].toSorted((a, b) => b[1] - a[1] || a[0] - b[0]);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || !second)
    throw new Error("Calibration needs multiple enrolled identities");
  const correct = scores.filter((item) => item.identity === target.identity);
  const wrong = scores.filter((item) => item.identity !== target.identity);
  const maximum = (items: typeof scores) =>
    items.length ? Math.max(...items.map((item) => item.score)) : null;
  const correctScore = maximum(correct);
  const wrongScore = maximum(wrong);
  return {
    cameraScope,
    file: target.file,
    sha256: target.sha256,
    split: target.split,
    identity: target.identity,
    camera: target.camera,
    clothing: target.clothing,
    enrolled: target.enrolled,
    scenario: !target.enrolled
      ? "unknown_identity"
      : target.clothing === 1
        ? "same_clothing"
        : "changed_clothing",
    bestIdentity: best[0],
    bestScore: best[1],
    margin: best[1] - second[1],
    correctScore,
    wrongScore,
    correctMargin:
      correctScore !== null && wrongScore !== null
        ? correctScore - wrongScore
        : null,
    correctSameCamera: maximum(
      correct.filter((item) => item.camera === target.camera),
    ),
    correctOtherCamera: maximum(
      correct.filter((item) => item.camera !== target.camera),
    ),
    // Static annotations are identity truth, never direct face confirmation.
    references: scores,
  };
}
const observations = features
  .filter((sample) => sample.role === "target")
  .flatMap((target) =>
    (["all", "same_camera", "other_camera"] as const).map((cameraScope) =>
      scoreTarget(
        target,
        features.filter(
          (sample) =>
            sample.role === "reference" &&
            sample.split === target.split &&
            (cameraScope === "all" ||
              (cameraScope === "same_camera"
                ? sample.camera === target.camera
                : sample.camera !== target.camera)),
        ),
        cameraScope,
      ),
    ),
  );
function decisions(
  rows: typeof observations,
  threshold: number,
  margin: number,
) {
  let correct = 0,
    wrong = 0,
    unknownAccepted = 0,
    abstained = 0;
  for (const row of rows) {
    if (row.bestScore < threshold || row.margin < margin || row.margin === 0)
      abstained++;
    else if (!row.enrolled) unknownAccepted++;
    else if (row.identity === row.bestIdentity) correct++;
    else wrong++;
  }
  const known = rows.filter((row) => row.enrolled).length;
  const unknown = rows.length - known;
  const accepted = correct + wrong + unknownAccepted;
  return {
    targets: rows.length,
    known,
    unknown,
    correct,
    wrong,
    unknownAccepted,
    abstained,
    accepted,
    correctCoverage: known ? correct / known : null,
    acceptedErrorRate: accepted ? (wrong + unknownAccepted) / accepted : null,
    unknownAcceptanceRate: unknown ? unknownAccepted / unknown : null,
  };
}
const tune = observations.filter(
  (row) => row.split === "tune" && row.cameraScope === "all",
);
const holdout = observations.filter(
  (row) => row.split === "holdout" && row.cameraScope === "all",
);
// Fixed grid declared before looking at holdout. Zero observed errors is not a safety guarantee.
const grid = [];
for (let score = 0; score <= 100; score++)
  for (let difference = 0; difference <= 100; difference++) {
    const threshold = score / 100,
      margin = difference / 100;
    grid.push({ threshold, margin, ...decisions(tune, threshold, margin) });
  }
const selected =
  grid
    .filter(
      (item) =>
        item.correct > 0 && item.wrong === 0 && item.unknownAccepted === 0,
    )
    .toSorted(
      (a, b) =>
        b.correct - a.correct ||
        b.margin - a.margin ||
        b.threshold - a.threshold,
    )[0] ?? null;
function summarize(rows: typeof observations) {
  const numbers = (
    field:
      | "correctScore"
      | "wrongScore"
      | "correctMargin"
      | "correctSameCamera"
      | "correctOtherCamera",
  ) => rows.flatMap((row) => (row[field] === null ? [] : [row[field]]));
  return {
    targets: rows.length,
    identities: [...new Set(rows.map((row) => row.identity))].toSorted(
      (a, b) => a - b,
    ),
    correctScore: distribution(numbers("correctScore")),
    wrongScore: distribution(numbers("wrongScore")),
    correctMargin: distribution(numbers("correctMargin")),
    correctSameCamera: distribution(numbers("correctSameCamera")),
    correctOtherCamera: distribution(numbers("correctOtherCamera")),
    selectedDecision: selected
      ? decisions(rows, selected.threshold, selected.margin)
      : null,
  };
}
// Representative failure selection uses tune only; holdout is summarized without choosing examples or changing policy.
const rejected = (row: (typeof observations)[number]) =>
  !selected ||
  row.bestScore < selected.threshold ||
  row.margin < selected.margin ||
  row.margin === 0;
const categories = [
  {
    name: "cross_camera_wrong_best",
    rows: observations.filter(
      (row) =>
        row.split === "tune" &&
        row.cameraScope === "other_camera" &&
        row.scenario === "same_clothing" &&
        row.bestIdentity !== row.identity,
    ),
  },
  {
    name: "cross_camera_correct_but_abstained",
    rows: observations.filter(
      (row) =>
        row.split === "tune" &&
        row.cameraScope === "other_camera" &&
        row.scenario === "same_clothing" &&
        row.bestIdentity === row.identity &&
        rejected(row),
    ),
  },
  {
    name: "clothes_changed_abstained",
    rows: observations.filter(
      (row) =>
        row.split === "tune" &&
        row.cameraScope === "all" &&
        row.scenario === "changed_clothing" &&
        rejected(row),
    ),
  },
];
const failureIndex = {
  source: dataset.source,
  modelSha256: model.metadata.sha256,
  frozenCandidate: selected
    ? { threshold: selected.threshold, margin: selected.margin }
    : null,
  selection:
    "tune only; sort correctMargin ascending then original file; choose first, middle, last; no holdout tuning or example selection",
  categories: categories.map(({ name, rows }) => {
    const ordered = rows.toSorted(
      (a, b) =>
        (a.correctMargin ?? -2) - (b.correctMargin ?? -2) ||
        a.file.localeCompare(b.file),
    );
    const positions = [
      ...new Set([0, Math.floor(ordered.length / 2), ordered.length - 1]),
    ].filter((index) => index >= 0 && index < ordered.length);
    return {
      name,
      count: rows.length,
      representatives: positions.map((index) => {
        const row = ordered[index]!;
        return {
          file: row.file,
          sha256: row.sha256,
          identity: row.identity,
          camera: row.camera,
          clothing: row.clothing,
          cameraScope: row.cameraScope,
          bestIdentity: row.bestIdentity,
          bestScore: row.bestScore,
          margin: row.margin,
          correctScore: row.correctScore,
          wrongScore: row.wrongScore,
          correctMargin: row.correctMargin,
          reason: !selected
            ? "no_frozen_candidate"
            : row.bestScore < selected.threshold
              ? "score_insufficient"
              : row.margin < selected.margin || row.margin === 0
                ? "candidates_close"
                : "wrong_acceptance",
          correctReferences: row.references
            .filter((item) => item.identity === row.identity)
            .toSorted((a, b) => b.score - a.score)
            .slice(0, 2),
          strongestWrongReferences: row.references
            .filter((item) => item.identity !== row.identity)
            .toSorted((a, b) => b.score - a.score)
            .slice(0, 2),
        };
      }),
    };
  }),
};

const cpu = process.cpuUsage(cpuStart);
const manifest = features.map(({ vector: _vector, ...sample }) => sample);
const result = {
  source: dataset.source,
  ...(await createPerceptionEnvironment()),
  model: { ...model.metadata, processingVersion: reidProcessingVersion },
  protocol: {
    referenceRule:
      "clothing 1 gallery, one per available camera, then earliest images up to five per identity",
    truth:
      "author's identity/camera/clothing filename labels; not face evidence",
    scoring:
      "production appearanceScore; highest of up to five references per identity; winner minus runner-up",
    selection:
      "fixed threshold/margin grid 0..1 step 0.01; most correct tune acceptances with zero observed errors (including unknown); ties prefer higher margin then threshold",
    onlineCalibrated: false,
    temporalPolicy: null,
    limitations: [
      "static body crops, not household scenes",
      "model training corpus undocumented; identity-disjoint holdout refers only to this calibration split",
      "no frame timestamps or face/body joint availability",
      "no two-new-frame support or TTL comparison",
      "similar clothing not independently annotated",
      "holdout identities disjoint, but same public dataset",
      "empirical zero tune errors is not a calibrated false-attribution guarantee",
      "near-adjacent images remain correlated; per-image rates are not independent trial probabilities",
      "no database/activity/UI or lifecycle acceptance",
    ],
  },
  input: {
    releaseImages: dataset.samples.length,
    uniqueImages: features.length,
    duplicateBytesSkipped: dataset.samples.length - features.length,
    references: features.filter((sample) => sample.role === "reference").length,
    manifestSha256: fingerprint(JSON.stringify(manifest, null, 2) + "\n"),
  },
  scoreCandidate: selected
    ? { threshold: selected.threshold, margin: selected.margin }
    : null,
  splits: ["tune", "holdout"].map((split) => ({
    split,
    all: summarize(split === "tune" ? tune : holdout),
    cameraScopes: ["all", "same_camera", "other_camera"].map((cameraScope) => ({
      cameraScope,
      scenarios: ["same_clothing", "changed_clothing", "unknown_identity"].map(
        (scenario) => ({
          scenario,
          ...summarize(
            observations.filter(
              (row) =>
                row.split === split &&
                row.cameraScope === cameraScope &&
                row.scenario === scenario,
            ),
          ),
        }),
      ),
    })),
  })),
  resources: {
    wallMs: performance.now() - started,
    cpuMs: (cpu.user + cpu.system) / 1000,
    decodeAndExtractMs: distribution(durations),
    sampledProcessRssPeakBytes: peakRss,
    modelCalls: features.length,
    scope:
      "offline process; per-image RSS samples; not online domain cache peak or continuous load",
  },
};
await mkdir(output, { recursive: true });
for (const [name, value] of [
  ["manifest.json", manifest],
  ["duplicates.json", duplicates],
  ["observations.json", observations],
  ["tune-grid.json", grid],
  ["failure-index.json", failureIndex],
  ["results.json", result],
] as const)
  await writeFileAtomic(
    join(output, name),
    JSON.stringify(value, null, 2) + "\n",
  );
console.log(JSON.stringify(result, null, 2));
