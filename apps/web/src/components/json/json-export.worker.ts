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
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage(exportJson(event.data));
});
