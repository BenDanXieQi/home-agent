import { m, useReducedMotion } from "motion/react";
import { contentSwap } from "../../utils/motion";
import { requestErrorMessage } from "../../messages/zh-CN";
import { useEffect, useRef, useState } from "react";
import {
  roomAnalysisStateSchema,
  validateInterpretation,
} from "@home-agent/api/room-analysis";
import { Button } from "../../components/Button";
import { requestJson } from "../../api/client";
import { subscribeRoomAnalysis } from "../../modules/room-analysis/subscription";

const statusLabels = {
  idle: "等待分析",
  queued: "等待合并变化",
  running: "正在分析",
  ready: "已更新",
  stale: "需要更新",
  error: "分析未完成",
  unavailable: "证据不足",
};
const time = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });

export function RoomAnalysisPanel({
  scope,
  roomId,
  synced,
  roomName,
}: {
  roomName: string;
  scope: string;
  roomId: string | null;
  synced: boolean;
}) {
  const reduced = useReducedMotion();
  const [state, setState] = useState<ReturnType<
    typeof roomAnalysisStateSchema.parse
  > | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    const stop = synced
      ? subscribeRoomAnalysis(
          { scope_epoch: scope, room_id: roomId },
          (result) => {
            setState(result);
            setError("");
            setSubmitting(false);
          },
          () => setError("分析状态连接中断，正在重新同步。"),
        )
      : undefined;
    return () => {
      controller.abort();
      stop?.();
    };
  }, [scope, roomId, synced]);
  async function analyze() {
    if (submitting || !synced) return;
    setSubmitting(true);
    const signal = operation.current?.signal;
    try {
      await requestJson(
        (client, options) =>
          client.api.rooms.analysis.run.$post(
            {
              json: { scope_epoch: scope, room_id: roomId },
            },
            options,
          ),
        roomAnalysisStateSchema,
        { signal },
      );
      if (!signal?.aborted) {
        setError("");
      }
    } catch (cause) {
      if (!signal?.aborted) setError(requestErrorMessage(cause));
    } finally {
      if (!signal?.aborted) setSubmitting(false);
    }
  }
  const latest = state?.latest;
  const result =
    latest && validateInterpretation(latest.context, latest.interpretation)
      ? latest.interpretation
      : null;
  const hiddenResult = !!latest && !result;
  const busy =
    submitting || state?.status === "queued" || state?.status === "running";
  const stale = !!latest?.stale_reason || !synced || !!error || hiddenResult;
  return (
    <m.section
      {...(reduced ? {} : contentSwap)}
      className="mb-5 rounded-2xl bg-surface p-5"
      aria-label="AI 房间上下文"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">
            {roomName}近况{" "}
            <span className="ml-2 text-xs font-normal text-muted">AI 观测</span>
          </h2>
          {latest ? (
            <p className="mt-1 text-xs text-muted">
              {time(latest.completed_at)}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <output
            className={stale ? "text-xs text-warning" : "text-xs text-muted"}
          >
            {!synced || error
              ? "等待同步"
              : hiddenResult && !busy
                ? "需要重新分析"
                : state
                  ? statusLabels[state.status]
                  : "正在读取"}
          </output>
          <Button
            disabled={!synced || busy}
            onClick={() => {
              analyze().catch(() => {
                console.warn("Room analysis request failed");
              });
            }}
          >
            {busy
              ? state?.status === "running"
                ? "正在分析…"
                : "等待分析…"
              : "分析当前房间"}
          </Button>
        </div>
      </header>
      {error ? (
        <p className="my-3 block rounded-xl bg-warning/5 p-3 text-sm text-warning">
          {error}
        </p>
      ) : null}
      {state?.message ? (
        <output className="my-3 block rounded-xl bg-warning/5 p-3 text-sm text-warning">
          {state.message}
        </output>
      ) : null}
      {latest?.stale_reason ? (
        <p className="my-3 block rounded-xl bg-warning/5 p-3 text-sm text-warning">
          {latest.stale_reason}
        </p>
      ) : null}
      {result && latest ? (
        <div
          className={stale ? "mt-4 border-l-2 border-warning/40 pl-3" : "mt-4"}
        >
          <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-7">
            {result.summary.text}
          </p>
          {result.unknowns.length ? (
            <div className="mt-3 text-xs leading-6 text-muted">
              <h3>还不能确定</h3>
              <ul className="list-disc pl-4">
                {result.unknowns.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted">
          {state?.status === "running"
            ? "正在根据本次房间证据生成总结…"
            : hiddenResult
              ? "这份总结未通过展示检查，已隐藏。请重新分析当前房间。"
              : "还没有 AI 总结。可以主动分析当前房间，之后由符合条件的设备变化触发更新。"}
        </p>
      )}
      <details className="mt-3 text-xs leading-6 text-muted">
        <summary className="cursor-pointer">分析信息</summary>
        {latest && result ? (
          <p>
            {stale ? "上一次总结" : "总结时间"}：{time(latest.completed_at)} ·{" "}
            {latest.usage.model} ·{" "}
            {(latest.usage.duration_ms / 1000).toFixed(1)} 秒 · 输入{" "}
            {latest.usage.input_tokens ?? "未知"} / 输出{" "}
            {latest.usage.output_tokens ?? "未知"} tokens
          </p>
        ) : null}
        {state ? (
          <>
            可自动触发的属性 {state.automatic_properties} 项 · 待处理变化{" "}
            {state.pending_changes} 项 · 分析请求 {state.attempts} 次 · 已采纳{" "}
            {state.accepted} 次
            {state.rejected ? ` · 因依据变化未采纳 ${state.rejected} 次` : ""}。
            <br />
          </>
        ) : null}
        {state?.automatic_properties === 0
          ? "当前尚无满足来源、有效期与触发策略要求的属性；可先手动分析待确认的观测。"
          : "相关可信变化触发分析，安静房间不重复调用 AI。"}
        同值上报和低于阈值的数值波动不会触发分析或使总结失效；累计变化达到阈值再处理。
        实际分析读取相关设备的最新状态，涵盖开启与关闭，不受下方设备筛选影响。仅提供解释，不执行设备操作。
      </details>
      <footer className="mt-3 text-xs text-muted">
        根据设备最近报告整理，仅展示观测描述；设备原始值可在下方设备状态中查看。
      </footer>
    </m.section>
  );
}
