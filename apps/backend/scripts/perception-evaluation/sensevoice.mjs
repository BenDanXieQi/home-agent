import { createRequire } from "node:module";
import { createReadStream, writeFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { cpus } from "node:os";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "runtime-dir": { type: "string" },
    "model-dir": { type: "string" },
    "vad-model": { type: "string" },
    output: { type: "string" },
    threads: { type: "string", default: "1" },
    repeats: { type: "string", default: "3" },
  },
});
for (const key of ["runtime-dir", "model-dir", "vad-model", "output"])
  if (!values[key]) throw new Error(`Missing --${key}`);
if (!positionals.length)
  throw new Error("Provide one or more 16 kHz mono WAV files");
const threads = Number(values.threads),
  repeats = Number(values.repeats);
if (
  !Number.isInteger(threads) ||
  threads < 1 ||
  threads > 4 ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 100
)
  throw new Error("threads must be 1–4 and repeats 1–100");
const require = createRequire(
  join(resolve(values["runtime-dir"]), "package.json"),
);
const sherpa = require("sherpa-onnx-node");
async function fingerprint(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const modelPath = join(resolve(values["model-dir"]), "model.int8.onnx");
const tokensPath = join(resolve(values["model-dir"]), "tokens.txt");
const vadPath = resolve(values["vad-model"]);
const metadata = {
  model: {
    sha256: await fingerprint(modelPath),
    bytes: statSync(modelPath).size,
  },
  tokensSha256: await fingerprint(tokensPath),
  vadSha256: await fingerprint(vadPath),
};
const vadConfig = {
  sileroVad: {
    model: vadPath,
    threshold: 0.4,
    minSilenceDuration: 0.5,
    minSpeechDuration: 0.25,
    windowSize: 512,
    maxSpeechDuration: 15,
  },
  sampleRate: 16000,
  numThreads: 1,
  provider: "cpu",
  debug: 0,
};
const rssBeforeLoad = process.memoryUsage().rss;
const loadStart = performance.now();
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: {
      model: modelPath,
      useInverseTextNormalization: 1,
      language: "auto",
    },
    tokens: tokensPath,
    numThreads: threads,
    provider: "cpu",
    debug: 0,
  },
});
const loadMs = performance.now() - loadStart;
const asrRssAfterLoad = process.memoryUsage().rss;
const vad = new sherpa.Vad(vadConfig, 30);
const vadRssAfterLoad = process.memoryUsage().rss;
function transcribe(samples) {
  const stream = recognizer.createStream();
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  stream.acceptWaveform({ samples, sampleRate: 16000 });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  return {
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    rtf: elapsedMs / (samples.length / 16),
    rssBytes: process.memoryUsage().rss,
    result,
  };
}
const cases = [];
for (const file of positionals) {
  if (statSync(file).size > 4 * 1024 * 1024)
    throw new Error("Input exceeds 4 MiB");
  const wave = sherpa.readWave(file);
  if (
    wave.sampleRate !== 16000 ||
    wave.samples.length === 0 ||
    wave.samples.length > 16000 * 60
  )
    throw new Error("Expected nonempty 16 kHz audio no longer than 60 seconds");
  // First call is recorded separately and excluded from steady-state timings.
  const first = transcribe(wave.samples);
  const runs = Array.from({ length: repeats }, () => transcribe(wave.samples));
  vad.reset();
  const segments = [];
  let vadMs = 0;
  function drain(deliveredSamples, flushed) {
    while (!vad.isEmpty()) {
      // Copy out of the native queue before pop; this benchmark decodes synchronously.
      const segment = vad.front(false);
      const samples = Float32Array.from(segment.samples);
      const startSample = segment.start;
      vad.pop();
      segments.push({
        startSample,
        endSample: startSample + samples.length,
        emittedAtSample: deliveredSamples,
        flushed,
        ...transcribe(samples),
        withContext: {
          startSample: Math.max(0, startSample - 3200),
          endSample: Math.min(
            deliveredSamples,
            startSample + samples.length + 1600,
          ),
          ...transcribe(
            wave.samples.subarray(
              Math.max(0, startSample - 3200),
              Math.min(deliveredSamples, startSample + samples.length + 1600),
            ),
          ),
        },
      });
    }
  }
  // Feed regular 32 ms blocks. Times are simulated source positions, not wall-clock latency.
  for (let offset = 0; offset < wave.samples.length; offset += 512) {
    const end = Math.min(offset + 512, wave.samples.length);
    const started = performance.now();
    vad.acceptWaveform(wave.samples.subarray(offset, end));
    vadMs += performance.now() - started;
    drain(end, false);
  }
  const flushStart = performance.now();
  vad.flush();
  vadMs += performance.now() - flushStart;
  drain(wave.samples.length, true);
  const entry = {
    file: resolve(file),
    sha256: await fingerprint(file),
    durationSeconds: wave.samples.length / 16000,
    first,
    runs,
    vadMs,
    segments,
    rssBytes: process.memoryUsage().rss,
  };
  cases.push(entry);
  console.error(
    JSON.stringify({
      file,
      text: first.result.text,
      meanMs:
        runs.reduce((total, run) => total + run.elapsedMs, 0) / runs.length,
      segments: segments.map((segment) => segment.result.text),
    }),
  );
}
writeFileSync(
  resolve(values.output),
  JSON.stringify(
    {
      environment: {
        runtime: process.versions,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        sherpa: require("sherpa-onnx-node/package.json").version,
      },
      metadata,
      config: { threads, repeats, vad: vadConfig, language: "auto", itn: true },
      loadMs,
      rssBeforeLoad,
      asrRssAfterLoad,
      vadRssAfterLoad,
      cases,
      resourceUsage: process.resourceUsage(),
      limitations: [
        "Offline replay, not wall-clock streaming",
        "Public/controlled audio, not household accuracy",
        "Synchronous decode must run outside the production event loop",
        "RSS includes both VAD and ASR",
      ],
    },
    null,
    2,
  ) + "\n",
);
