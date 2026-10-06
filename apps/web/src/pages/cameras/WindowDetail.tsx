import { JsonData } from "../../components/json/JsonData";
import { Button } from "../../components/Button";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import { windowRequestUnavailable } from "../../modules/perception/windows";
import type { useWindowDetail } from "../../modules/perception/use-window-detail";
import {
  windowTime,
  visualReasons,
  candidateLabel,
  petSoundLabels,
  petSoundStatuses,
} from "../../modules/perception/window-presentation";
import { WindowIdentity } from "./WindowIdentity";
import { WindowRecording } from "./WindowRecording";
import { WindowSpeech } from "./WindowSpeech";
import { projectWindowMaterial } from "@home-agent/api/perception/window-observations";
import { WindowMaterialSummary } from "../../components/WindowMaterialSummary";
import {
  windowAudioStates,
  windowVadStates,
} from "../../modules/perception/window-presentation";

export function WindowDetail({
  detail,
  active,
}: {
  detail: ReturnType<typeof useWindowDetail>;
  active: boolean;
}) {
  const { query, window } = detail;
  if (windowRequestUnavailable(query.error))
    return <StatusNotice>此窗口已不可读取，请选择新的片段。</StatusNotice>;
  if (query.isError && !query.data)
    return (
      <Notice tone="error">
        片段详情读取失败：{requestErrorMessage(query.error)}
        <Button
          disabled={!active}
          onClick={() => {
            // Refetch reports failures through query.error.
            // oxlint-disable-next-line typescript/no-floating-promises
            query.refetch();
          }}
        >
          重新读取
        </Button>
      </Notice>
    );
  if (!window)
    return active ? <StatusNotice>正在读取片段详情…</StatusNotice> : null;
  return (
    <article
      aria-label="所选窗口"
      className="min-w-0 space-y-4 rounded-2xl border border-line p-4"
    >
      <h3 className="font-medium">
        {windowTime(window.startedAt)} – {windowTime(window.endedAt)} ·{" "}
        {candidateLabel(window)}
      </h3>
      <WindowMaterialSummary material={projectWindowMaterial(window)} />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">视觉筛选</dt>
        <dd>
          {visualReasons[window.gate.visual]} · 变化{" "}
          {(window.gate.changedRatio * 100).toFixed(2)}%
        </dd>
        <dt className="text-muted">声音输入</dt>
        <dd>{windowAudioStates[window.audio.status]}</dd>
        <dt className="text-muted">声音筛选</dt>
        <dd>
          {window.gate.audioPassed ? "通过" : "未通过"} · 能量过阈{" "}
          {window.audio.activeEnergyBlocks}/{window.audio.energyBlocks} 块
        </dd>
        <dt className="text-muted">人声检测</dt>
        <dd>{windowVadStates[window.audio.vad]}</dd>
        {window.audio.petSounds ? (
          <>
            <dt className="text-muted">猫狗声音</dt>
            <dd>
              {petSoundStatuses[window.audio.petSounds.status]}
              {window.audio.petSounds.chunks.flatMap((chunk) =>
                chunk.detections.map((detection) => (
                  <p key={`${chunk.startSample}:${detection.kind}`}>
                    {petSoundLabels[detection.kind]} · {detection.label} · 分数{" "}
                    {detection.score.toFixed(3)}
                    {" · "}
                    {windowTime(chunk.observedStartAt)}–
                    {windowTime(chunk.observedEndAt)}
                  </p>
                )),
              )}
              {window.audio.petSounds.status === "ready" &&
              !window.audio.petSounds.chunks.some(
                (chunk) => chunk.detections.length > 0,
              )
                ? " · 已完成的分析未达到猫狗声阈值"
                : null}
              {window.audio.petSounds.error ? (
                <p className="text-danger">{window.audio.petSounds.error}</p>
              ) : null}
            </dd>
          </>
        ) : null}
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
      <JsonData
        key={window.id}
        value={window}
        label="窗口原始数据 JSON"
        name={`window-${window.id}`}
      />
    </article>
  );
}
