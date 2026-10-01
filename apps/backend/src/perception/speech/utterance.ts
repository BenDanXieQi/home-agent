import { FrameProcessor } from "@ricky0123/vad-web/dist/frame-processor";
import { Message } from "@ricky0123/vad-web/dist/messages";
import type { audioTrackSchema } from "@home-agent/api/contracts";
import type { z } from "zod";
import { speechLimits } from "./limits";

// Keep the pinned package subpaths here: its root also imports browser/ONNX modules.
// Existing Silero probabilities are the only model input to this segmenter.
export function createUtterances(options: {
  speech: () => void;
  activity: (active: boolean) => void;
  segment: (segment: {
    startSample: number;
    endSample: number;
    speechEndSample: number;
    boundary: "pause" | "length_limit";
    samples: Float32Array;
  }) => void;
}) {
  let probability = 0,
    endSample = 0,
    speechEndSample = 0;
  let forced = false;
  let resetSample = 0;
  let segmentLimit: number | undefined;
  const preSpeechSamples =
    (speechLimits.preSpeechPadMs * speechLimits.sampleRate) / 1000;
  const processor = new FrameProcessor(
    () =>
      Promise.resolve({ isSpeech: probability, notSpeech: 1 - probability }),
    // Segment boundaries do not reset the continuous P3 model; its audio run owns that state.
    () => {},
    {
      positiveSpeechThreshold: speechLimits.positiveThreshold,
      negativeSpeechThreshold: speechLimits.negativeThreshold,
      redemptionMs: speechLimits.redemptionMs,
      preSpeechPadMs: speechLimits.preSpeechPadMs,
      minSpeechMs: speechLimits.minSpeechMs,
      submitUserSpeechOnPause: false,
    },
    (speechLimits.frameSamples / speechLimits.sampleRate) * 1000,
  );
  const event: Parameters<FrameProcessor["process"]>[1] = (value) => {
    if (value.msg === Message.SpeechRealStart) options.speech();
    if (value.msg === Message.SpeechStart) {
      segmentLimit =
        Math.max(
          resetSample,
          endSample - speechLimits.frameSamples - preSpeechSamples,
        ) + speechLimits.maxSegmentSamples;
      options.activity(true);
    }
    if (value.msg === Message.SpeechEnd || value.msg === Message.VADMisfire) {
      segmentLimit = undefined;
      resetSample = endSample;
    }
    if (value.msg === Message.SpeechEnd) {
      const startSample = endSample - value.audio.length;
      options.segment({
        startSample,
        endSample,
        speechEndSample: Math.max(startSample + 1, speechEndSample),
        boundary: forced ? "length_limit" : "pause",
        samples: value.audio,
      });
      options.activity(false);
    } else if (value.msg === Message.VADMisfire) options.activity(false);
  };
  processor.resume();
  return {
    get speaking() {
      return segmentLimit !== undefined;
    },
    async accept(
      block: Pick<
        z.infer<typeof audioTrackSchema>["vad"][number],
        "probability" | "startSample" | "endSample"
      >,
      samples: Float32Array,
    ) {
      if (
        block.startSample !== endSample ||
        samples.length !== speechLimits.frameSamples
      )
        throw new Error("Speech segment PCM discontinuity");
      endSample = block.endSample;
      probability = block.probability;
      if (probability >= speechLimits.positiveThreshold)
        speechEndSample = endSample;
      await processor.process(samples, event);
      // Enforce our sample budget from speech events, without inspecting library buffers.
      if (segmentLimit !== undefined && endSample >= segmentLimit) {
        forced = true;
        try {
          processor.endSegment(event);
        } finally {
          forced = false;
        }
      }
    },
    reset() {
      processor.reset();
      segmentLimit = undefined;
      resetSample = endSample;
    },
  };
}
