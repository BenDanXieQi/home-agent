import { test, expect } from "bun:test";
import { createAudioAnalysis } from "../../src/perception/audio/analysis";
import {
  createSileroTrack,
  createVad,
} from "../../src/perception/audio/silero-vad";

// Physical observations must not change with transport chunking or activity on another camera.
const pcm = Int16Array.from({ length: 16_777 }, (_, index) =>
  Math.round(12000 * Math.sin(index * 0.173) * (index < 9000 ? 1 : 0.2)),
);
async function observe(
  analysis: ReturnType<typeof createAudioAnalysis>,
  input: Int16Array,
  sizes: number[],
) {
  const energy = [],
    vad = [];
  let offset = 0,
    part = 0;
  let last;
  while (offset < input.length) {
    const next = Math.min(input.length, offset + sizes[part++ % sizes.length]!);
    last = await analysis.accept(input.subarray(offset, next));
    energy.push(...last.energy);
    vad.push(...last.vad);
    offset = next;
  }
  if (!last) throw new Error("Expected audio samples");
  return {
    energy,
    vad,
    samples: last.samples,
    energyRemainder: last.energyRemainder,
    vadRemainder: last.vadRemainder,
  };
}

test("the same sound yields the same facts despite transport chunking and another camera", async () => {
  const model = await createVad();
  const evaluate = model.evaluate.bind(model);
  try {
    const uninterrupted = await observe(
      createAudioAnalysis(createSileroTrack(evaluate)),
      pcm,
      [pcm.length],
    );
    const partitioned = await observe(
      createAudioAnalysis(createSileroTrack(evaluate)),
      pcm,
      [17, 511, 3, 977, 129],
    );
    expect(partitioned).toEqual(uninterrupted);
    const first = createAudioAnalysis(createSileroTrack(evaluate));
    const other = createAudioAnalysis(createSileroTrack(evaluate));
    const actual = [];
    for (let offset = 0; offset < pcm.length; offset += 512) {
      actual.push(
        ...(await first.accept(pcm.subarray(offset, offset + 512))).vad,
      );
      await other.accept(new Int16Array(1024));
    }
    expect(actual).toEqual(uninterrupted.vad);
    // A replacement track must behave like a fresh source, not inherit another run's speech history.
    const replacement = await observe(
      createAudioAnalysis(createSileroTrack(evaluate)),
      pcm,
      [320, 1024],
    );
    expect(replacement).toEqual(uninterrupted);
  } finally {
    await model.close();
  }
}, 15000);

test("a missing speech model preserves audible energy without claiming absence of speech", async () => {
  const result = await createAudioAnalysis(createSileroTrack()).accept(
    new Int16Array(960).fill(16384),
  );
  expect(result.energy.map(({ rms, active }) => ({ rms, active }))).toEqual([
    { rms: 0.5, active: true },
    { rms: 0.5, active: true },
  ]);
  expect(result.vadStatus).toBe("unavailable");
  expect(result.vad).toEqual([]);
});

test("clear speech is reported as speech while the surrounding silent room remains quiet", async () => {
  const spoken = new Int16Array(
    await Bun.file(
      new URL("./fixtures/speech-16k.pcm", import.meta.url),
    ).arrayBuffer(),
  );
  const input = new Int16Array(16000 + spoken.length + 16000);
  input.set(spoken, 16000);
  const model = await createVad();
  try {
    const facts = await observe(
      createAudioAnalysis(createSileroTrack(model.evaluate.bind(model))),
      input,
      [317, 911, 64],
    );
    expect(
      facts.vad
        .filter((block) => block.endSample <= 16000)
        .every((block) => !block.aboveThreshold),
    ).toBe(true);
    expect(
      facts.vad
        .filter(
          (block) =>
            block.startSample >= 16000 &&
            block.endSample <= 16000 + spoken.length,
        )
        .some((block) => block.aboveThreshold),
    ).toBe(true);
    expect(
      facts.energy
        .filter((block) => block.endSample <= 16000)
        .every((block) => !block.active),
    ).toBe(true);
    expect(facts.energy.some((block) => block.active)).toBe(true);
    expect(
      facts.vad
        .filter((block) => block.startSample >= 16000 + spoken.length + 8000)
        .every((block) => !block.aboveThreshold),
    ).toBe(true);
  } finally {
    await model.close();
  }
}, 15000);
