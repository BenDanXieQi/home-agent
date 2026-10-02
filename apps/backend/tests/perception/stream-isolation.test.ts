import { test, expect } from "bun:test";
import { Hono } from "hono";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { setTimeout as delay } from "node:timers/promises";
import { createSnapshotStream } from "../../src/http/snapshot-stream";

// A stopped browser must not hold up another observer or make it replay stale facts.
test("a slow subscriber does not delay a healthy subscriber and both can release their slots", async () => {
  const listeners = new Set<() => void>();
  let sequence = 0;
  const shutdown = new AbortController();
  const requests = new AbortController();
  const service = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const app = new Hono().get(
    "/",
    createSnapshotStream(
      service,
      () => ({ sequence, observation: "x".repeat(128 * 1024) }),
      shutdown.signal,
    ),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: app.fetch,
  });
  let last = -1;
  let readingError: unknown;
  let reading: Promise<void> | undefined;
  try {
    const slow = await fetch(server.url, { signal: requests.signal });
    const fast = await fetch(server.url, { signal: requests.signal });
    const events = fast
      .body!.pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());
    reading = (async () => {
      for await (const event of events)
        if (event.event === "snapshot") last = JSON.parse(event.data).sequence;
    })().catch((error: unknown) => {
      if (!requests.signal.aborted) readingError = error;
    });
    for (let next = 1; next <= 120; next++) {
      sequence = next;
      for (const listener of listeners) listener();
      await delay(3);
    }
    const deadline = performance.now() + 2000;
    const receivedLatest = () => last >= 120;
    while (!receivedLatest() && performance.now() < deadline) await delay(10);
    expect(readingError).toBeUndefined();
    expect(last).toBe(120);
    await slow.body!.cancel();
    requests.abort();
    await Promise.allSettled([reading]);
    const closed = performance.now() + 1000;
    while (listeners.size && performance.now() < closed) await delay(10);
    expect(listeners.size).toBe(0);
  } finally {
    requests.abort();
    shutdown.abort();
    await Promise.allSettled(reading ? [reading] : []);
    await server.stop(true);
  }
}, 10000);

test("an observer joining after a fact expires sees its current validity without requiring new media", async () => {
  let elapsedMs = 0;
  const requests = new AbortController();
  const shutdown = new AbortController();
  const app = new Hono().get(
    "/",
    createSnapshotStream(
      { subscribe: () => () => {} },
      () => ({
        observedAt: 0,
        validity: elapsedMs < 2000 ? "valid" : "expired",
      }),
      shutdown.signal,
    ),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
    idleTimeout: 0,
  });
  const readers = [];
  try {
    const first = await fetch(server.url, { signal: requests.signal });
    const initial = first
      .body!.pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
      .getReader();
    readers.push(initial);
    expect(JSON.parse((await initial.read()).value!.data).validity).toBe(
      "valid",
    );
    // Time advances; the camera does not publish another packet or event.
    elapsedMs = 2500;
    const joined = await fetch(server.url, { signal: requests.signal });
    const latest = joined
      .body!.pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
      .getReader();
    readers.push(latest);
    expect(JSON.parse((await latest.read()).value!.data).validity).toBe(
      "expired",
    );
  } finally {
    requests.abort();
    shutdown.abort();
    await Promise.allSettled(readers.map((reader) => reader.cancel()));
    await server.stop(true);
  }
}, 5000);
