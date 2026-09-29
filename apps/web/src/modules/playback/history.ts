import {
  estimateRemainingPlaybackTime,
  mergePlaybackHistorySamples,
  playbackHistoryGroupKey,
  playbackHistoryPolicy,
  playbackHistorySampleSchema,
  type PlaybackHistorySample,
  type PlaybackHistoryTarget,
} from "./estimates";
import {
  observePlaybackEnvironment,
  readPlaybackEnvironment,
} from "./environment";

const prefix = "home-agent.playback.";
const storedSamples = playbackHistorySampleSchema
  .array()
  .max(playbackHistoryPolicy.maximumSamples);
const groups = new Map<string, PlaybackHistorySample[]>();
let initialized = false;
let generation = 0;
let stopEnvironment: (() => void) | undefined;

function persist(key: string, samples?: readonly PlaybackHistorySample[]) {
  // Retry on each success: storage may recover without a group being evicted.
  try {
    if (samples?.length)
      localStorage.setItem(prefix + key, JSON.stringify(samples));
    else localStorage.removeItem(prefix + key);
  } catch {
    // History remains available in memory, independently of browser storage.
  }
}

function removeGroup(key: string) {
  groups.delete(key);
  persist(key);
}

function prune(now: number) {
  for (const [key, samples] of groups) {
    const latest = samples[0];
    if (
      !latest ||
      now - latest.recordedAt >= playbackHistoryPolicy.lifetimeMs
    ) {
      removeGroup(key);
    }
  }
  if (groups.size <= playbackHistoryPolicy.maximumGroups) return;
  const oldest = [...groups].toSorted(
    (a, b) => a[1][0]!.recordedAt - b[1][0]!.recordedAt,
  );
  for (const [key] of oldest.slice(
    0,
    groups.size - playbackHistoryPolicy.maximumGroups,
  )) {
    removeGroup(key);
  }
}

function initialize() {
  if (initialized) return;
  initialized = true;
  try {
    // Load a browser-local snapshot once. Each success updates only its camera
    // group; approximate history does not require live cross-tab coordination.
    const keys = Object.keys(localStorage).filter((key) =>
      key.startsWith(prefix),
    );
    const now = Date.now();
    const environment = readPlaybackEnvironment();
    for (const storageKey of keys) {
      const key = storageKey.slice(prefix.length);
      try {
        const raw = localStorage.getItem(storageKey);
        const parsed =
          raw && raw.length <= 64_000
            ? storedSamples.safeParse(JSON.parse(raw))
            : null;
        const samples = parsed?.success
          ? mergePlaybackHistorySamples(
              parsed.data.filter(
                (sample) =>
                  sample.environment === environment &&
                  playbackHistoryGroupKey(
                    sample,
                    sample.sourceRecentlyActive,
                  ) === key,
              ),
              now,
            )
          : [];
        if (samples.length) groups.set(key, samples);
        else removeGroup(key);
      } catch {
        removeGroup(key);
      }
    }
    prune(now);
  } catch {
    // A later successful playback can retry storage without reloading the page.
  }
  stopEnvironment = observePlaybackEnvironment(() => {
    generation++;
    for (const key of groups.keys()) removeGroup(key);
  });
}

export function beginPlaybackHistory(target: PlaybackHistoryTarget) {
  initialize();
  return { ...target, generation, environment: readPlaybackEnvironment() };
}

export function recordPlaybackHistory(
  context: ReturnType<typeof beginPlaybackHistory>,
  input: Omit<PlaybackHistorySample, "environment">,
) {
  if (context.generation !== generation) return;
  const parsed = playbackHistorySampleSchema.safeParse({
    ...input,
    environment: context.environment,
  });
  if (!parsed.success) return;
  const sample = parsed.data;
  if (
    sample.revision !== context.revision ||
    sample.deviceId !== context.deviceId ||
    sample.channel !== context.channel
  )
    return;
  const key = playbackHistoryGroupKey(sample, sample.sourceRecentlyActive);
  const now = Date.now();
  const samples = mergePlaybackHistorySamples(
    [...(groups.get(key) ?? []), sample],
    now,
  );
  groups.set(key, samples);
  prune(now);
  if (groups.has(key)) persist(key, samples);
}

/** A failed startup makes that camera's old successful waits unreliable. */
export function invalidatePlaybackHistory(
  context: ReturnType<typeof beginPlaybackHistory>,
  sourceRecentlyActive: boolean | null,
) {
  if (context.generation !== generation) return;
  for (const source of sourceRecentlyActive === null
    ? [true, false]
    : [sourceRecentlyActive]) {
    removeGroup(playbackHistoryGroupKey(context, source));
  }
}

export function estimatePlaybackHistory({
  context,
  sourceRecentlyActive,
  ...clock
}: {
  context: ReturnType<typeof beginPlaybackHistory> | null;
  sourceRecentlyActive: boolean | null;
} & Parameters<typeof estimateRemainingPlaybackTime>[1]) {
  if (
    !context ||
    context.generation !== generation ||
    sourceRecentlyActive === null
  )
    return null;
  const samples =
    groups.get(playbackHistoryGroupKey(context, sourceRecentlyActive)) ?? [];
  return estimateRemainingPlaybackTime(samples, clock);
}

if (import.meta.hot) import.meta.hot.dispose(() => stopEnvironment?.());
