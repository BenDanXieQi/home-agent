export function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

export async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

export async function eventually(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Expected asynchronous progress");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
