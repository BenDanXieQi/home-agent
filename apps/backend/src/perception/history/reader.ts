import {
  compareWindowPosition,
  matchesWindowMarker,
  windowMarkers,
  createWindowHistoryMatcher,
} from "./query";
import {
  perceptionWindowHistoryRecordSchema,
  type windowListQuerySchema,
  type windowSummarySchema,
  type perceptionWindowsHistoryQuerySchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import type { createWindowHistory } from "./service";
import type { createWindowStore } from "../window/store";
import type { createWindowMedia } from "../media/window-media";
import type { PerceptionSources } from "../sources";
import { HouseholdError } from "../../household/errors";

export class PerceptionHistoryError extends Error {}

export function createWindowHistoryReader({
  windows,
  media,
  history,
  sources,
  unavailable,
  stopped,
}: {
  windows: ReturnType<typeof createWindowStore>;
  media: ReturnType<typeof createWindowMedia>;
  history: ReturnType<typeof createWindowHistory> | undefined;
  sources: PerceptionSources;
  unavailable: () => boolean;
  stopped: () => boolean;
}) {
  const assertReadable = (signal: AbortSignal | undefined) => {
    signal?.throwIfAborted();
    if (stopped()) throw new HouseholdError("stale_session");
  };
  return {
    async listWindows(
      selection: z.infer<typeof windowListQuerySchema>,
      signal?: AbortSignal,
    ) {
      assertReadable(signal);
      const archived = await history?.list(selection, signal);
      assertReadable(signal);
      const markers = sources.eligibility(selection)
        ? (archived?.stored
            ? archived.markers
            : windowMarkers([
                ...windows.snapshot(Date.now(), selection).windows,
                ...(archived?.markers ?? []),
              ])
          )
            .filter((entry) => matchesWindowMarker(entry, selection))
            .toSorted((a, b) => compareWindowPosition(b, a))
        : [];
      const markerPage = markers.slice(0, 50);
      const lastMarker = markerPage.at(-1);
      return {
        markers: markerPage,
        next:
          markers.length > 50 && lastMarker
            ? { before: lastMarker.startedAt, beforeId: lastMarker.id }
            : null,
        history: history?.status() ?? { enabled: false, error: null },
      };
    },
    async readWindow(id: string, signal?: AbortSignal) {
      assertReadable(signal);
      let failure: HouseholdError | undefined;
      const saved = await history?.get(id, signal).catch((cause: unknown) => {
        if (
          !(cause instanceof HouseholdError && cause.reason === "home_storage")
        )
          throw cause;
        failure = cause;
        return undefined;
      });
      assertReadable(signal);
      const live = windows.describe(id, Date.now());
      if (
        live &&
        live.inputState !== "revoked" &&
        sources.eligibility(live.run)
      )
        return {
          ...live,
          summaryUntil: saved?.summaryUntil ?? live.summaryUntil,
          analysisAcceptingUntil:
            windows.access(id, Date.now())?.analysisAcceptingUntil ?? null,
          sampledMedia: media.sampledMedia(id),
        };
      if (failure) throw failure;
      return saved && sources.eligibility(saved.run)
        ? { ...saved, analysisAcceptingUntil: null, sampledMedia: null }
        : undefined;
    },
    historyAccess(entry: z.infer<typeof windowSummarySchema>) {
      if (
        unavailable() ||
        entry.summaryUntil <= Date.now() ||
        !sources.eligibility(entry.run)
      )
        return undefined;
      const live = windows.access(entry.id, Date.now());
      if (!live && !history) return undefined;
      return {
        inputState:
          live && live.inputState !== "revoked"
            ? live.inputState
            : ("expired" as const),
        analysisAcceptingUntil: live?.analysisAcceptingUntil ?? null,
        sampledMedia: media.sampledMedia(entry.id),
      };
    },
    async *history(
      input: Pick<
        z.infer<typeof perceptionWindowsHistoryQuerySchema>,
        "start" | "end" | "sources" | "limit"
      >,
      after?: Pick<
        z.infer<typeof perceptionWindowHistoryRecordSchema>["window"],
        "startedAt" | "id"
      >,
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      if (unavailable())
        throw new PerceptionHistoryError("Perception history unavailable");
      const matcher = createWindowHistoryMatcher(input);
      const matchesInterval = matcher.interval;
      const archived = (await history?.history(input, after, signal)) ?? [];
      signal?.throwIfAborted();
      if (unavailable())
        throw new PerceptionHistoryError("Perception history unavailable");
      const liveCandidates = windows.selectDetails(Date.now(), {
        ...(after ? { after } : {}),
        limit: input.limit + 1,
        matches: (entry) => matcher.matches(entry),
      });
      const archivedIds = new Set(archived.map((entry) => entry.id));
      const candidates = new Map(archived.map((entry) => [entry.id, entry]));
      for (const entry of liveCandidates)
        candidates.set(entry.id, {
          ...entry,
          summaryUntil:
            candidates.get(entry.id)?.summaryUntil ?? entry.summaryUntil,
        });
      for (const entry of [...candidates.values()]
        .toSorted(compareWindowPosition)
        .slice(0, input.limit + 1)) {
        signal?.throwIfAborted();
        if (unavailable())
          throw new PerceptionHistoryError("Perception history unavailable");
        const matches = {
          visual: matchesInterval(entry.startedAt, entry.endedAt)
            ? [{ window_id: entry.id }]
            : [],
          audio:
            entry.audio.run &&
            entry.audio.startedAt !== null &&
            entry.audio.endedAt !== null &&
            matchesInterval(entry.audio.startedAt, entry.audio.endedAt)
              ? [
                  {
                    track_run_id: entry.audio.run.trackRunId,
                    generation: entry.audio.generation,
                  },
                ]
              : [],
          speech: entry.speech.segments
            .filter((segment) =>
              matchesInterval(segment.observedStartAt, segment.observedEndAt),
            )
            .map((segment) => ({ id: segment.id })),
        };
        if (!sources.eligibility(entry.run)) continue;
        const sampledMedia = media.sampledMedia(entry.id);
        const access = windows.access(entry.id, Date.now());
        if (
          !archivedIds.has(entry.id) &&
          (!access || access.inputState === "revoked")
        )
          continue;
        yield perceptionWindowHistoryRecordSchema.parse({
          window: {
            ...entry,
            analysisAcceptingUntil: access?.analysisAcceptingUntil ?? null,
            sampledMedia,
          },
          matches,
        });
      }
    },
  };
}
