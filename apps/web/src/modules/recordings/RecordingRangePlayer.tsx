import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import { recordingAvailabilityOptions, type RecordingTarget } from "./api";
import {
  originalMediaOptions,
  recordingRangesOptions,
  type RecordingMediaInput,
} from "./originals";
import {
  recordingLookupUnavailableText,
  recordingUnavailableText,
} from "./presentation";
import { useRecordingPlayback } from "./use-recording-playback";

function dateInput(at: number) {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 23);
}

export function RecordingRangePlayer({
  target,
  playbackTarget,
  scope,
  active,
  initialStart,
  initialEnd,
  observedAt,
  autoPlay = false,
}: {
  target: Pick<RecordingMediaInput, "deviceId" | "channel">;
  playbackTarget: RecordingTarget | null;
  scope: string;
  active: boolean;
  initialStart?: number | undefined;
  initialEnd?: number | undefined;
  observedAt?: number | undefined;
  autoPlay?: boolean;
}) {
  const [request, setRequest] = useState(() => {
    if (initialStart === undefined || initialEnd === undefined)
      return undefined;
    const focusAt =
      observedAt !== undefined &&
      initialStart <= observedAt &&
      observedAt < initialEnd
        ? observedAt
        : initialStart;
    return {
      start: initialStart - 30_000,
      end: initialEnd + 30_000,
      at: focusAt - 30_000,
      focusAt,
    };
  });
  const [start, setStart] = useState<string>();
  const [end, setEnd] = useState<string>();
  const [error, setError] = useState<string>();
  const [completed, setCompleted] = useState(false);
  const [playRequested, setPlayRequested] = useState(autoPlay);
  const [sourceRead, setSourceRead] = useState(0);
  const player = useRef<HTMLVideoElement>(null);
  const client = useQueryClient();
  const rangeQuery = recordingRangesOptions(scope, target);
  const rangeOptions = {
    ...rangeQuery,
    queryKey: [
      ...rangeQuery.queryKey,
      JSON.stringify([request?.start, request?.end, sourceRead]),
    ],
  };
  const ranges = useQuery({
    ...rangeOptions,
    enabled: active,
    refetchInterval: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const locating =
    request !== undefined && request.at === request.focusAt - 30_000;
  const localRange = request
    ? ranges.data?.ranges.find(
        (range) =>
          (range.start <= request.at && request.at < range.end) ||
          (locating &&
            range.start <= request.focusAt &&
            request.focusAt < range.end),
      )
    : undefined;
  const localCovered = localRange !== undefined;
  const readAt = request
    ? Math.max(request.at, localRange?.start ?? request.at)
    : undefined;
  const availabilityAt = request
    ? locating
      ? [request.at, request.focusAt]
      : [request.at]
    : [];
  const availabilityQuery = recordingAvailabilityOptions(
    playbackTarget && request && !localCovered && !ranges.isPending
      ? { ...playbackTarget, at: availabilityAt }
      : undefined,
  );
  const availabilityOptions = {
    ...availabilityQuery,
    queryKey: [...availabilityQuery.queryKey, String(sourceRead)],
  };
  const availability = useQuery({
    ...availabilityOptions,
    enabled:
      active &&
      !!playbackTarget &&
      !!request &&
      !localCovered &&
      !ranges.isPending,
    refetchInterval: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const clip =
    availability.data?.status === "ready"
      ? (availability.data.matches.find((match) => match.clip !== null)?.clip ??
        availability.data.matches.find((match) => match.at === request?.at)
          ?.clip)
      : undefined;
  const availableRange = ranges.data?.ranges.at(-1);
  const defaultEnd = availableRange?.end;
  const defaultStart =
    availableRange && defaultEnd !== undefined
      ? Math.max(availableRange.start, defaultEnd - 30_000)
      : undefined;
  const startAt = request?.start ?? defaultStart;
  const endAt = request?.end ?? defaultEnd;
  const startValue = start ?? (startAt === undefined ? "" : dateInput(startAt));
  const endValue = end ?? (endAt === undefined ? "" : dateInput(endAt));
  const localEnd =
    request && readAt !== undefined && localRange
      ? Math.min(readAt + 30_000, request.end, localRange.end)
      : undefined;
  const localQuery = originalMediaOptions(
    scope,
    localCovered && readAt !== undefined && localEnd !== undefined
      ? {
          ...target,
          source: "local",
          selection: { kind: "range", start: readAt, end: localEnd },
          output: { kind: "video", codec: "h264" },
        }
      : undefined,
  );
  const localOptions = {
    ...localQuery,
    queryKey: [...localQuery.queryKey, `read:${sourceRead}`],
  };
  const local = useQuery({
    ...localOptions,
    enabled: active && localCovered,
  });
  const localFile = local.data?.media[0];
  const playback = useRecordingPlayback(
    active && !localCovered ? playbackTarget : null,
  );
  const { start: play, cancel } = playback;
  const resource =
    playback.state?.state === "ready" && !playback.expired
      ? playback.state
      : undefined;
  const fileUrl = resource?.fileUrl;
  const mediaStart = localFile ? local.data?.startedAt : clip?.startAt;

  useEffect(() => {
    if (!active || !request || !clip || availability.isError) return undefined;
    play({ kind: "clip", startAt: clip.startAt });
    return cancel;
  }, [active, request, clip, availability.isError, play, cancel]);

  useEffect(() => {
    const node = player.current;
    if (!node || !active || (!fileUrl && !localFile)) return undefined;
    const url = localFile ? URL.createObjectURL(localFile) : fileUrl;
    if (!url) return undefined;
    node.src = url;
    return () => {
      node.pause();
      node.removeAttribute("src");
      node.load();
      if (localFile) URL.revokeObjectURL(url);
    };
  }, [active, fileUrl, localFile]);

  useEffect(() => {
    if (active) return;
    Promise.all([
      client.cancelQueries({ queryKey: availabilityOptions.queryKey }),
      client.cancelQueries({ queryKey: rangeOptions.queryKey }),
      client.cancelQueries({ queryKey: localOptions.queryKey }),
    ]).catch((cause: unknown) => {
      console.error("Recording read cancellation failed", cause);
    });
  }, [
    active,
    client,
    availabilityOptions.queryKey,
    rangeOptions.queryKey,
    localOptions.queryKey,
  ]);

  const busy =
    ranges.isFetching ||
    availability.isFetching ||
    playback.pending ||
    local.isFetching;
  const retry = () => {
    if (busy) return;
    setError(undefined);
    setCompleted(false);
    setPlayRequested(true);
    setSourceRead((value) => value + 1);
  };
  const failure =
    error ??
    (availability.error
      ? `录像查询失败：${requestErrorMessage(availability.error)}`
      : local.error
        ? `本地录像读取失败：${requestErrorMessage(local.error)}`
        : playback.error
          ? `录像读取失败：${requestErrorMessage(playback.error)}`
          : playback.expired
            ? "本次回看已到保留期限，请重新读取。"
            : playback.state?.state === "unavailable"
              ? recordingUnavailableText[playback.state.reason]
              : playback.state?.state === "revoked"
                ? "录像访问资格已失效。"
                : availability.data?.status === "unavailable"
                  ? recordingLookupUnavailableText[availability.data.reason]
                  : clip === null
                    ? "所选时间存在录像缺口，无法继续播放。"
                    : active &&
                        request &&
                        !ranges.isPending &&
                        !localCovered &&
                        !playbackTarget
                      ? "摄像头 SD 录像当前不可读取。"
                      : undefined);

  function updatePlaybackProgress(node: HTMLVideoElement) {
    if (completed && node.currentTime < node.duration) setCompleted(false);
  }

  function browse(direction: "before" | "after") {
    if (!request || mediaStart === undefined || busy) return;
    const boundary =
      direction === "before" ? mediaStart : localFile ? localEnd : clip?.endAt;
    if (boundary === undefined) return;
    const startedAt = direction === "before" ? boundary - 60_000 : boundary;
    const endedAt = direction === "before" ? boundary : boundary + 60_000;
    setError(undefined);
    setCompleted(false);
    setPlayRequested(true);
    setStart(undefined);
    setEnd(undefined);
    setRequest({
      start: startedAt,
      end: endedAt,
      at: startedAt,
      focusAt: startedAt,
    });
  }

  return (
    <section aria-label="历史录像播放" className="space-y-3 p-4">
      <div className="grid aspect-video max-h-[65dvh] place-items-center overflow-hidden bg-[#111111] text-white/70">
        {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={player}
          hidden={!resource && !localFile}
          controls
          autoPlay={playRequested}
          muted={autoPlay}
          playsInline
          preload="metadata"
          aria-label="所选时间范围的原始录像"
          className="size-full object-contain"
          onLoadedMetadata={(event) => {
            if (!request || mediaStart === undefined) return;
            const node = event.currentTarget;
            const offset = Math.max(0, (request.at - mediaStart) / 1000);
            if (!Number.isFinite(node.duration) || offset >= node.duration) {
              node.pause();
              setError("所选时间未被录像覆盖，无法播放。");
              return;
            }
            node.currentTime = offset;
          }}
          onTimeUpdate={(event) => updatePlaybackProgress(event.currentTarget)}
          onSeeking={(event) => updatePlaybackProgress(event.currentTarget)}
          onPlay={(event) => updatePlaybackProgress(event.currentTarget)}
          onEnded={(event) => {
            if (!active || !request || mediaStart === undefined) return;
            // The final local frame can cover more than the requested range.
            const playedUntil = localFile
              ? local.data?.endedAt
              : mediaStart + event.currentTarget.currentTime * 1000;
            if (
              (playedUntil !== undefined && playedUntil >= request.end) ||
              (localFile
                ? localEnd === request.end
                : clip && clip.endAt >= request.end)
            ) {
              setCompleted(true);
              return;
            }
            setCompleted(false);
            const nextAt = localFile ? localEnd : clip?.endAt;
            if (
              nextAt === undefined ||
              nextAt <= request.at ||
              nextAt >= request.end
            ) {
              setError("录像时间信息与实际时长不一致，无法到达所选结束时间。");
              return;
            }
            setPlayRequested(true);
            setRequest({ ...request, at: nextAt });
          }}
          onError={() => {
            setError("浏览器无法播放录像，请重试。");
          }}
        />
        {!resource && !localFile ? (
          <p className="px-4 text-center text-sm">
            {request
              ? failure
                ? "所选录像无法播放"
                : "正在加载录像…"
              : "选择时间回看录像"}
          </p>
        ) : null}
      </div>
      {completed ? (
        <StatusNotice>本次录像已播放完，可继续向后查看。</StatusNotice>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Button
          disabled={!active || busy || mediaStart === undefined}
          onClick={() => browse("before")}
        >
          向前查看
        </Button>
        <Button
          disabled={!active || busy || mediaStart === undefined}
          onClick={() => browse("after")}
        >
          继续向后看
        </Button>
        <p className="text-xs text-muted">
          可拖动查看当前录像全程，或向前、向后查看更早和更晚的录像。
        </p>
      </div>
      {failure ? <Notice tone="error">{failure}</Notice> : null}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const startedAt = new Date(startValue).getTime();
          const endedAt = new Date(endValue).getTime();
          if (
            !Number.isFinite(startedAt) ||
            !Number.isFinite(endedAt) ||
            startedAt >= endedAt
          ) {
            setError("请选择有效的时间，结束时间须晚于开始时间。");
            return;
          }
          setError(undefined);
          setCompleted(false);
          setPlayRequested(true);
          setStart(startValue);
          setEnd(endValue);
          if (
            request?.start === startedAt &&
            request.end === endedAt &&
            request.at === startedAt
          ) {
            const node = player.current;
            if (
              (resource || localFile) &&
              node &&
              mediaStart !== undefined &&
              !failure
            ) {
              if (node.readyState >= 1)
                node.currentTime = Math.max(0, (startedAt - mediaStart) / 1000);
              node.play().catch((cause: unknown) => {
                setError(`录像播放失败：${requestErrorMessage(cause)}`);
              });
            } else retry();
            return;
          }
          setRequest({
            start: startedAt,
            end: endedAt,
            at: startedAt,
            focusAt: startedAt,
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-3 text-sm [&_input]:min-h-10 [&_input]:rounded-lg [&_input]:border [&_input]:border-line [&_input]:bg-surface [&_input]:px-2">
          <label className="mb-0 grid gap-1">
            开始时间
            <input
              type="datetime-local"
              step="0.001"
              required
              value={startValue}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label className="mb-0 grid gap-1">
            结束时间
            <input
              type="datetime-local"
              step="0.001"
              required
              value={endValue}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
          <Button
            type="submit"
            className="min-h-10"
            disabled={!active || busy || !startValue || !endValue}
            status={busy ? "pending" : "idle"}
          >
            播放
          </Button>
          {failure && request ? (
            <Button
              type="button"
              className="min-h-10"
              disabled={!active || busy}
              onClick={retry}
            >
              重试播放
            </Button>
          ) : null}
        </div>
        {!request && ranges.error ? (
          <Notice tone="error">
            本地录像时间查询失败：{requestErrorMessage(ranges.error)}
          </Notice>
        ) : !request && !availableRange ? (
          <StatusNotice>
            {ranges.isPending
              ? "正在查询本地录像…"
              : "本地暂无对应录像，可按时间读取摄像头 SD 录像。"}
          </StatusNotice>
        ) : null}
      </form>
    </section>
  );
}
