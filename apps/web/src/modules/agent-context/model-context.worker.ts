import {
  createHouseholdModelView,
  encodeHouseholdContext,
  ModelContextError,
} from "@home-agent/api/household-model-view";

export function compressModelContext(
  snapshot: Parameters<typeof createHouseholdModelView>[0],
) {
  try {
    const value = encodeHouseholdContext(
      createHouseholdModelView(snapshot).semantic,
    );
    return {
      status: "ready" as const,
      value,
      bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
    };
  } catch (error) {
    if (!(error instanceof ModelContextError))
      console.error("Model context conversion failed", error);
    return {
      status: "failed" as const,
      reason:
        error instanceof ModelContextError
          ? error.code
          : ("conversion_failed" as const),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

self.addEventListener(
  "message",
  (event: MessageEvent<Parameters<typeof compressModelContext>[0]>) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated worker messaging has no targetOrigin.
    self.postMessage(compressModelContext(event.data));
  },
);
