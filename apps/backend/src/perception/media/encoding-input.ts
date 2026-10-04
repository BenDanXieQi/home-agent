import type { z } from "zod";
import type { mediaViewSchema } from "@home-agent/api/contracts";
import type { createWindowDraft } from "../window/aggregate";

// The encoder consumes media and immutable facts, never the store's retention state.
export type WindowEncodingInput = Pick<
  z.infer<typeof mediaViewSchema>,
  "representation" | "parameters"
> & {
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
