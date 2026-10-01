import type { representationParameters } from "./representation";
import type { createWindowDraft } from "../window/aggregate";

// The encoder consumes media and immutable facts, never the store's retention state.
export type WindowEncodingInput = {
  summary: Parameters<typeof representationParameters>[0];
  input: {
    frames: readonly Readonly<
      Pick<
        ReturnType<typeof createWindowDraft>["frames"][number],
        "rgb" | "retainedWidth" | "retainedHeight"
      >
    >[];
    audio: readonly Readonly<
      Pick<
        ReturnType<typeof createWindowDraft>["audio"][number],
        "pcm" | "startedAt"
      >
    >[];
  };
};
