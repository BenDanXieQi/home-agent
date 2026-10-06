/** Independent exports serialize only when requested, away from the UI thread. */
export function exportJson(value: unknown) {
  try {
    return {
      kind: "ready" as const,
      blob: new Blob([JSON.stringify(value, null, 2) ?? "null"], {
        type: "application/json",
      }),
    };
  } catch {
    return { kind: "failed" as const };
  }
}
self.addEventListener("message", (event: MessageEvent<unknown>) => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated worker messaging has no targetOrigin.
  self.postMessage(exportJson(event.data));
});
