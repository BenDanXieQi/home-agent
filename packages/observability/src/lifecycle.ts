const pending = new Set<Promise<void>>();

export function beginOperation() {
  let resolve!: () => void;
  const operation = new Promise<void>((done) => {
    resolve = done;
  });
  pending.add(operation);
  return () => {
    pending.delete(operation);
    resolve();
  };
}

export async function drainOperations() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        // A cancelling graph can still be waiting for a child model call to settle.
        while (pending.size) await Promise.allSettled(pending);
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            "Telemetry shutdown: active operations exceeded the 10s drain budget",
          );
          resolve();
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
