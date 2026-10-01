import type { SpeechAnalysis } from "./analysis";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { InferenceSession, Tensor } from "onnxruntime-node";

export const vadSha256 =
  "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f";
export async function createVad() {
  const bytes = await readFile(
    new URL("../../../models/silero_vad.onnx", import.meta.url),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== vadSha256)
    throw new Error("VAD model fingerprint mismatch");
  const session = await InferenceSession.create(bytes, {
    executionProviders: ["cpu"],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: "sequential",
  });
  try {
    if (
      session.inputNames.join() !== "input,state,sr" ||
      session.outputNames.join() !== "output,stateN"
    )
      throw new Error("VAD tensor names mismatch");
    const metadata = session.inputMetadata;
    if (
      !metadata[0]?.isTensor ||
      metadata[0].type !== "float32" ||
      !metadata[1]?.isTensor ||
      metadata[1].type !== "float32" ||
      !metadata[2]?.isTensor ||
      metadata[2].type !== "int64" ||
      metadata[0].shape.length !== 2 ||
      metadata[1].shape.length !== 3 ||
      metadata[1].shape[0] !== 2 ||
      metadata[1].shape[2] !== 128 ||
      metadata[2].shape.length !== 0 ||
      !session.outputMetadata[0]?.isTensor ||
      session.outputMetadata[0].type !== "float32" ||
      session.outputMetadata[0].shape.length !== 2 ||
      session.outputMetadata[0].shape[1] !== 1 ||
      !session.outputMetadata[1]?.isTensor ||
      session.outputMetadata[1].type !== "float32" ||
      session.outputMetadata[1].shape.length !== 3
    )
      throw new Error("VAD tensor types mismatch");
    return {
      metadata: {
        sha256: vadSha256,
        provider: "cpu" as const,
        inputs: metadata,
        outputs: session.outputMetadata,
      },
      async evaluate(input: Float32Array, state: Float32Array) {
        const tensors = {
          input: new Tensor("float32", input, [1, 576]),
          state: new Tensor("float32", state, [2, 1, 128]),
          sr: new Tensor("int64", new BigInt64Array([16000n]), []),
        };
        const outputs = await session.run(tensors).finally(() => {
          for (const tensor of Object.values(tensors)) tensor.dispose();
        });
        try {
          const probability = outputs.output,
            next = outputs.stateN;
          if (
            !probability ||
            !(probability.data instanceof Float32Array) ||
            JSON.stringify(probability.dims) !== "[1,1]" ||
            !next ||
            !(next.data instanceof Float32Array) ||
            JSON.stringify(next.dims) !== "[2,1,128]" ||
            !Number.isFinite(probability.data[0]) ||
            probability.data[0]! < 0 ||
            probability.data[0]! > 1 ||
            !next.data.every(Number.isFinite)
          )
            throw new Error("Invalid VAD output");
          return {
            probability: probability.data[0]!,
            state: Float32Array.from(next.data),
          };
        } finally {
          for (const value of Object.values(outputs)) value.dispose();
        }
      },
      close: () => session.release(),
    };
  } catch (error) {
    await session.release();
    throw error;
  }
}

// Each track owns its model state, 64-sample context and unfinished 512-sample block.
// The supplied evaluator serializes calls to the one process-wide ONNX session.
export function createSileroTrack(
  evaluate?: Awaited<ReturnType<typeof createVad>>["evaluate"],
  observe?: (
    block: Awaited<ReturnType<SpeechAnalysis["accept"]>>["blocks"][number],
    samples: Float32Array,
  ) => Promise<void>,
) {
  let state = new Float32Array(256);
  const input = new Float32Array(576);
  let count = 0;
  let error: string | undefined;
  return {
    async accept(pcm: Int16Array, startSample: number) {
      const blocks: Awaited<ReturnType<SpeechAnalysis["accept"]>>["blocks"] =
        [];
      for (let index = 0; index < pcm.length; index++) {
        input[64 + count++] = pcm[index]! / 32768;
        if (count !== 512) continue;
        count = 0;
        if (!evaluate || error) continue;
        try {
          const result = await evaluate(input, state);
          state = result.state;
          input.copyWithin(0, 512, 576);
          const endSample = startSample + index + 1;
          const block = {
            startSample: endSample - 512,
            endSample,
            probability: result.probability,
          };
          blocks.push(block);
          if (observe)
            await observe(block, Float32Array.from(input.subarray(64)));
        } catch (cause) {
          error = String(cause).slice(0, 4096);
          state.fill(0);
          input.fill(0);
        }
      }
      return {
        blocks,
        remainder: count,
        status:
          !evaluate || error
            ? ("unavailable" as const)
            : startSample + pcm.length < 512
              ? ("insufficient_input" as const)
              : ("ready" as const),
        error,
      };
    },
  } satisfies SpeechAnalysis;
}
