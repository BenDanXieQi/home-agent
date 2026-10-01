import { addAbortListener } from "node:events";
import type { PerceptionSources } from "./sources";

export async function prepareSourceLease(
  sources: PerceptionSources,
  source: Parameters<typeof sources.prepare>[0],
  signal: AbortSignal,
  retire: () => void,
) {
  const prepared = await sources.prepare(source, signal);
  const lifetime = AbortSignal.any([signal, prepared.signal]);
  lifetime.throwIfAborted();
  addAbortListener(lifetime, () => {
    if (!signal.aborted) retire();
  });
  return prepared.access;
}
