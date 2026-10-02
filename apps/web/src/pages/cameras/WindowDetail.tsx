import { memo, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import {
  windowDetailOptions,
  windowRequestUnavailable,
  type WindowListEntry,
} from "../../modules/perception/windows";
import {
  windowTime,
  visualReasons,
  candidateLabel,
} from "./window-presentation";
import { WindowMedia } from "./WindowMedia";
import { WindowIdentity } from "./WindowIdentity";
import { WindowRecording } from "./WindowRecording";
import { WindowSpeech } from "./WindowSpeech";

export const WindowDetail = memo(function WindowDetail({
  entry,
  scope,
  active,
}: {
  entry: WindowListEntry;
  scope: string;
  active: boolean;
}) {
  const query = useQuery({
    ...windowDetailOptions(scope, entry.id),
    enabled: (cached) =>
      active && !windowRequestUnavailable(cached.state.error),
    refetchInterval: (cached) =>
      !cached.state.error &&
      cached.state.data &&
      cached.state.data.revision < entry.revision
        ? 500
        : false,
  });
  // Frame judgments are frozen. Only completed speech can add historical evidence.
  const window = useMemo(
    () =>
      query.data
        ? {
            ...query.data,
            inputState: entry.inputState,
            sampledMedia: entry.sampledMedia,
            summaryUntil: entry.summaryUntil,
          }
        : undefined,
    [query.data, entry.inputState, entry.sampledMedia, entry.summaryUntil],
  );
  const [jsonOpen, setJsonOpen] = useState(false);
  const json = useMemo(
    () => (jsonOpen && window ? JSON.stringify(window, null, 2) : null),
    [jsonOpen, window],
  );
  if (windowRequestUnavailable(query.error))
    return <StatusNotice>此窗口已不可读取，请选择新的片段。</StatusNotice>;
  if (query.isError && !query.data)
    return (
      <Notice tone="error">
        窗口详情读取失败：{requestErrorMessage(query.error)}
        <Button
          disabled={!active}
          onClick={() => {
            // refetch owns request failures and exposes them through query.error.
            // oxlint-disable-next-line typescript/no-floating-promises
            query.refetch();
          }}
        >
          重新读取
        </Button>
      </Notice>
    );
  if (!window)
    return active ? <StatusNotice>正在读取窗口详情…</StatusNotice> : null;
  return (
    <article
      aria-label="所选窗口"
      className="min-w-0 space-y-4 rounded-2xl border border-line p-4"
    >
      <h3 className="font-medium">
        {windowTime(window.startedAt)} – {windowTime(window.endedAt)} ·{" "}
        {candidateLabel(window)}
      </h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">视觉筛选</dt>
        <dd>
          {visualReasons[window.gate.visual]} · 变化{" "}
          {(window.gate.changedRatio * 100).toFixed(2)}%
        </dd>
        <dt className="text-muted">声音输入</dt>
        <dd>
          {
            {
              available: "可用",
              no_track: "无音轨",
              missing: "缺失",
              insufficient_input: "输入不足",
              failed: "失败",
            }[window.audio.status]
          }
        </dd>
        <dt className="text-muted">声音筛选</dt>
        <dd>
          {window.gate.audioPassed ? "通过" : "未通过"} · 能量过阈{" "}
          {window.audio.activeEnergyBlocks}/{window.audio.energyBlocks} 块
        </dd>
        <dt className="text-muted">人声检测</dt>
        <dd>
          {
            {
              speech: "检出人声",
              no_speech: "未检出人声",
              insufficient_input: "输入不足",
              unavailable: "不可用",
            }[window.audio.vad]
          }
        </dd>
        <dt className="text-muted">完整性</dt>
        <dd>
          {window.incomplete ? "不完整窗口" : "完整区间"} ·{" "}
          {window.frames.length} 张采样帧
        </dd>
      </dl>
      <p className="text-xs leading-5 text-muted">
        时间来自本机接收，音视频同步精度未知。媒体可提前淘汰；窗口图片为最后一张实际保留帧，视频为采样画面。
      </p>
      {window.gaps.length ? (
        <Notice tone="warning">
          <strong>输入缺口</strong>
          <ul className="list-inside list-disc break-words text-xs">
            {window.gaps.map((gap, index) => (
              <li key={`${index}:${gap}`}>{gap}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {window.gate.candidate === "none" ? (
        <StatusNotice>该窗口未通过筛选，没有可申请的媒体。</StatusNotice>
      ) : (
        <WindowMedia window={window} scope={scope} active={active} />
      )}
      <WindowSpeech window={window} />
      <WindowIdentity frames={window.frames} />
      <WindowRecording window={window} active={active} />
      {query.isError ? (
        <Notice tone="warning">
          新增转写暂未更新：{requestErrorMessage(query.error)}
          <Button
            disabled={!active}
            onClick={() => {
              // Refetch exposes any failure through query.error.
              // oxlint-disable-next-line typescript/no-floating-promises
              query.refetch();
            }}
          >
            重新读取
          </Button>
        </Notice>
      ) : null}
      <details
        open={jsonOpen}
        onToggle={(event) => setJsonOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer rounded text-xs text-muted focus-visible:outline-2">
          窗口原始数据 JSON
        </summary>
        {jsonOpen ? (
          <pre className="mt-2 max-h-96 overflow-auto rounded-xl bg-surface p-3 text-xs">
            {json}
          </pre>
        ) : null}
      </details>
    </article>
  );
});
