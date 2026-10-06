import { useState } from "react";
import { JsonData } from "../../components/json/JsonData";
import { time } from "./presentation";
import type { PerceptionWindow } from "../../modules/perception/windows";
import { projectWindowMaterial } from "@home-agent/api/perception/window-observations";
import { WindowMaterialSummary } from "../../components/WindowMaterialSummary";
import {
  windowAudioStates,
  windowVadStates,
} from "../../modules/perception/window-presentation";

export function WindowView({ window }: { window: PerceptionWindow }) {
  const [index, setIndex] = useState(0);
  const frame = window.frames[Math.min(index, window.frames.length - 1)];
  return (
    <div className="space-y-3 text-sm">
      <p>
        {time(window.startedAt)} — {time(window.endedAt)}
      </p>
      <WindowMaterialSummary material={projectWindowMaterial(window)} />
      <p>
        {window.frames.length} 帧 ·{" "}
        {window.incomplete ? "标记不完整" : "未标记不完整"} ·{" "}
        {window.gaps.length} 个缺口
      </p>
      {window.frames.length ? (
        <label className="block text-xs">
          观察帧 {Math.min(index + 1, window.frames.length)} /{" "}
          {window.frames.length}
          <input
            className="mt-2 block w-full"
            aria-label="观察帧"
            type="range"
            min={0}
            max={window.frames.length - 1}
            value={Math.min(index, window.frames.length - 1)}
            onChange={(e) => setIndex(Number(e.target.value))}
          />
        </label>
      ) : null}
      {frame ? (
        <>
          <svg
            className="w-full rounded-xl bg-surface"
            viewBox={`0 0 ${frame.width} ${frame.height}`}
            aria-label="检测框位置示意，非摄像头原图"
          >
            <title>检测框位置示意，非摄像头原图</title>
            {(frame.detections ?? []).map((d, i) => (
              <g key={i}>
                <rect
                  x={d.x}
                  y={d.y}
                  width={d.w}
                  height={d.h}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                />
                <text
                  x={Math.max(0, Math.min(d.x, frame.width - 150))}
                  y={Math.max(20, d.y - 6)}
                  fill="currentColor"
                  fontSize={18}
                >
                  {d.className} {d.confidence.toFixed(3)}
                </text>
              </g>
            ))}
          </svg>
          <p className="text-xs text-muted">
            检测位置示意，非原图 · {time(frame.receivedAt)}
            。检测分数不是身份概率。
          </p>
          <JsonData
            key={frame.sequence}
            value={frame.identity}
            label="本帧身份判断"
          />
        </>
      ) : null}
      <p>
        声音输入：{windowAudioStates[window.audio.status]} · 人声检测：
        {windowVadStates[window.audio.vad]}
      </p>
      <p>转写：{window.speech.enabled ? "已启用" : "未启用"}</p>
      {window.speech.segments.length ? (
        <ol className="space-y-2">
          {window.speech.segments.map((segment) => (
            <li key={segment.id} className="rounded-xl bg-surface p-3">
              <p className="text-xs text-muted">
                {time(segment.observedStartAt)} — {time(segment.observedEndAt)}
              </p>
              <p className="mt-2 whitespace-pre-wrap break-words">
                {segment.text}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted">
          当前发布值没有转写片段，不代表当时没有人讲话。
        </p>
      )}
      {window.speech.truncated ? (
        <p className="text-xs text-warning">窗口转写已截断。</p>
      ) : null}
      <p className="text-xs text-muted">
        跨窗口语音可能重复出现，文字尚未关联说话人身份。
      </p>
      <JsonData value={window.speech} label="完整转写内容与时间" />
      <JsonData value={window.sampledMedia} label="媒体引用、有效期与状态" />
      <p className="text-xs text-muted">
        本页只读发布材料，不触发媒体编码。完整帧、声音、转写、媒体和来源字段见下方
        JSON。
      </p>
    </div>
  );
}
