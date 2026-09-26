/** Explicit barriers make cancellation and overlapping requests deterministic. */
export function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

/** Let detached async continuations finish before asserting absence of side effects. */
export async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Wait for observable progress, with a bounded deadline rather than fixed sleeps. */
export async function eventually(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Expected asynchronous progress");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
