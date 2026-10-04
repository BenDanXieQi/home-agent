import { useState } from "react";
import { mediaRepresentationSchema } from "@home-agent/api/contracts";
import { Button } from "../../components/Button";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import {
  type PerceptionWindow,
  type WindowMediaSelection,
  windowRequestUnavailable,
} from "../../modules/perception/windows";

import {
  mediaStates,
  representations,
  windowTime,
} from "./window-presentation";
import { useWindowMedia } from "../../modules/perception/use-window-media";
import {
  useWindowInputState,
  useWindowMediaState,
} from "../../modules/perception/use-window-input-state";
import { WindowMediaPreview } from "./WindowMediaPreview";

export function WindowMedia({
  window,
  scope,
  active,
  autoPlay = false,
}: {
  window: PerceptionWindow;
  scope: string;
  active: boolean;
  autoPlay?: boolean;
}) {
  const canGenerate = useWindowInputState(window) === "available";
  const [representation, setRepresentation] = useState<
    WindowMediaSelection["representation"]
  >(window.sampledMedia?.selection.representation ?? "video");
  const [includeAudio, setIncludeAudio] = useState(
    window.sampledMedia?.selection.includeAudio ?? false,
  );
  const selection = {
    representation,
    includeAudio: representation.endsWith("video") && includeAudio,
  };
  return (
    <section aria-label="窗口媒体" className="space-y-3 pb-4 [&>p]:px-4">
      <MediaRequest
        key={`${representation}:${selection.includeAudio}`}
        scope={scope}
        id={window.id}
        selection={selection}
        canGenerate={canGenerate}
        active={active}
        autoPlay={autoPlay}
      />
      <div className="flex flex-wrap items-center gap-3 px-4">
        <label className="flex items-center gap-2 whitespace-nowrap text-sm">
          媒体类型
          <select
            value={representation}
            onChange={(event) =>
              setRepresentation(
                mediaRepresentationSchema.parse(event.target.value),
              )
            }
            className="min-h-10 w-auto rounded-lg border border-line bg-surface px-3 text-ink focus-visible:outline-2"
          >
            {mediaRepresentationSchema.options
              .filter((value) =>
                value === "audio"
                  ? window.audio.status === "available"
                  : window.gate.candidate === "video",
              )
              .map((value) => (
                <option key={value} value={value}>
                  {representations[value]}
                </option>
              ))}
          </select>
        </label>
        {representation.endsWith("video") &&
        window.audio.status === "available" ? (
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 shrink-0 rounded-sm p-0 accent-ink"
              checked={includeAudio}
              onChange={(event) => setIncludeAudio(event.target.checked)}
            />
            <span className="whitespace-nowrap">携带片段声音</span>
          </label>
        ) : null}
      </div>
      {!canGenerate ? (
        <p className="text-xs text-muted">
          原始输入已释放；仍可切换查看已保存的媒体，不能生成新的媒体。
        </p>
      ) : null}
    </section>
  );
}

function MediaRequest({
  scope,
  id,
  selection,
  canGenerate,
  active,
  autoPlay,
}: {
  canGenerate: boolean;
  scope: string;
  id: string;
  selection: WindowMediaSelection;
  active: boolean;
  autoPlay: boolean;
}) {
  const { query, mutation, error } = useWindowMedia(
    scope,
    id,
    selection,
    active,
  );
  const media = query.data;
  const state = useWindowMediaState(media);
  const unavailable = windowRequestUnavailable(error);
  return (
    <div className="space-y-3 [&>p]:px-4">
      <div className="grid aspect-video max-h-[65dvh] place-items-center overflow-hidden bg-[#111111] text-white/70">
        {unavailable ? (
          <span className="px-4 text-center text-sm">
            此媒体已不可读取，请选择新的片段。
          </span>
        ) : media?.state === "ready" && media.mediaId ? (
          <WindowMediaPreview
            key={media.mediaId}
            scope={scope}
            id={id}
            selection={selection}
            mediaId={media.mediaId}
            available={state === "ready"}
            active={active}
            autoPlay={autoPlay}
          />
        ) : (
          <span className="text-sm">
            {state ? mediaStates[state] : "正在加载片段…"}
          </span>
        )}
      </div>
      {active && query.isPending ? (
        <StatusNotice>正在查询媒体状态…</StatusNotice>
      ) : null}
      {error ? (
        <Notice tone="error">{requestErrorMessage(error)}</Notice>
      ) : null}
      {query.isError && !unavailable ? (
        <Button
          disabled={!active}
          onClick={() => {
            // refetch owns request failures and exposes them through query.error.
            // oxlint-disable-next-line typescript/no-floating-promises
            query.refetch();
          }}
        >
          重新查询状态
        </Button>
      ) : null}
      {!query.isError && media ? (
        <>
          {state ? (
            <p className="text-xs text-muted">
              {mediaStates[state]} · 最晚保留至{" "}
              {windowTime(media.readableUntil)}
            </p>
          ) : null}
          {state === "not_generated" || state === "failed" ? (
            <>
              {media.error ? (
                <Notice tone="error">生成失败：{media.error}</Notice>
              ) : null}
              {canGenerate ? (
                <Button
                  disabled={!active || mutation.isPending}
                  status={mutation.isPending ? "pending" : "idle"}
                  onClick={() => mutation.mutate(media.state === "failed")}
                >
                  {media.state === "failed"
                    ? "重试生成"
                    : `打开${representations[selection.representation]}`}
                </Button>
              ) : null}
            </>
          ) : null}
          {state === "expired" || state === "evicted" ? (
            <StatusNotice>
              已完整加载到本页的副本仍可播放，切换媒体或离开后释放。
            </StatusNotice>
          ) : null}

          {media.state === "ready" ? (
            <p className="text-xs leading-5 text-muted">
              {media.parameters.width && media.parameters.height
                ? `${media.parameters.width} × ${media.parameters.height} · `
                : ""}
              {media.parameters.crop ? "实际裁切" : "未裁切"} ·{" "}
              {media.parameters.audioIncluded ? "含声音" : "不含声音"}。
              {selection.representation.startsWith("crop_") &&
              !media.parameters.crop
                ? "没有合适裁切区域，使用全景。"
                : ""}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
