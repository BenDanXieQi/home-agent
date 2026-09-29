import { twMerge } from "tailwind-merge";
import { buttonStyles } from "../../components/button-styles";
import { Notice, StatusNotice } from "../../components/Notice";
import { useMemo } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence } from "motion/react";
import { Download, Play, Square } from "lucide-react";
import type { DeviceLogSnapshot } from "@home-agent/api/device-logs";
import {
  captureLogsAtom,
  deviceLogCaptureAtom,
  deviceLogScopeAtom,
} from "../../modules/device-logs/state";
import { PageHeaderContent } from "../../components/PageHeaderContent";
import { Button } from "../../components/Button";
import { Switch } from "../../components/Switch";
import { Skeleton } from "../../components/Skeleton";
import { contentSwap } from "../../utils/motion";
import { requestErrorMessage } from "../../messages/zh-CN";
import { time } from "./presentation";

const statusLabels = {
  capturing: "采集中",
  complete: "采集完成",
  stopped: "已停止",
  interrupted: "采集中断",
  error: "采集异常",
};

export function CaptureControls({
  run,
  connected,
  loaded,
  ready,
  paused,
  unseen,
  onLiveChange,
  onCaptured,
}: {
  run: DeviceLogSnapshot["run"];
  connected: boolean;
  loaded: boolean;
  ready: boolean;
  paused: boolean;
  unseen: number;
  onLiveChange: (live: boolean) => void;
  onCaptured: () => void;
}) {
  const scope = useAtomValue(deviceLogScopeAtom);
  const performCapture = useSetAtom(captureLogsAtom);
  const captureState = useAtomValue(deviceLogCaptureAtom);
  const pending = captureState.pending;
  const captureAction = captureState.action;
  const confirming = captureState.phase === "confirming" && !connected;
  const error = captureState?.error
    ? requestErrorMessage(captureState.error)
    : null;
  const capturing = run?.status === "capturing";

  async function capture(action: "start" | "stop") {
    if (pending) return;
    if (await performCapture({ action, scope })) onCaptured();
  }
  const remaining = Math.max(
    0,
    (run?.duration_seconds ?? 600) - Math.floor(run?.elapsed_seconds ?? 0),
  );
  const startedAt = run?.started_at;
  const startedTime = useMemo(
    () => (startedAt ? time(startedAt) : ""),
    [startedAt],
  );
  return (
    <>
      <PageHeaderContent slot="actions">
        <fieldset
          className="flex items-center justify-between flex-wrap gap-y-2 gap-x-4 min-w-0 text-[12px]"
          aria-label="日志采集控制"
        >
          {!loaded ? (
            <>
              <output
                className="flex items-center gap-3 flex-wrap"
                aria-label="正在读取采集状态"
              >
                <span className="flex gap-1.75 items-center font-semibold relative min-w-19 [&_i]:w-1.5 [&_i]:h-1.5 [&_i]:rounded-full [&_i]:bg-current data-[status=capturing]:text-sage data-[status=complete]:text-sage data-[status=interrupted]:text-warning data-[status=error]:text-danger [&[data-status='capturing']_i]:status-ping [&[data-status='complete']_i]:status-ping">
                  <Skeleton className="my-[0.2lh] h-[0.6lh] w-14" />
                </span>
                <span className="text-muted text-[11px] tabular-nums max-[901px]:ml-0">
                  <Skeleton className="my-[0.2lh] h-[0.6lh] w-24" />
                </span>
              </output>
              <div className="flex items-center justify-between gap-2 flex-wrap [&_.button]:min-h-7.5 [&_.button]:py-1.5 [&_.button]:px-2.5 [&_.button]:text-[12px] [&_.button]:whitespace-nowrap">
                <Skeleton className="h-[30px] w-24 rounded-md" />
                <Skeleton className="h-[30px] w-16 rounded-md" />
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <span
                  className="flex gap-1.75 items-center font-semibold relative min-w-19 data-[status=capturing]:text-sage data-[status=complete]:text-sage data-[status=interrupted]:text-warning data-[status=error]:text-danger [&[data-status='capturing']_i]:status-ping [&[data-status='complete']_i]:status-ping"
                  data-status={pending ? "pending" : run?.status}
                >
                  <i className="w-1.5 h-1.5 rounded-full bg-current" />
                  <span>
                    {pending
                      ? confirming
                        ? "等待同步"
                        : captureAction === "stop"
                          ? "正在停止"
                          : "正在启动"
                      : run
                        ? statusLabels[run.status]
                        : "未采集"}
                  </span>
                </span>
                <span className="text-muted text-[11px] tabular-nums max-[901px]:ml-0">
                  {capturing
                    ? `剩余 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
                    : run
                      ? `${startedTime} 的记录`
                      : "每次 10 分钟"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <AnimatePresence mode="popLayout" initial={false}>
                  {capturing && (
                    <Switch
                      key="live"
                      className="mr-2"
                      layout="position"
                      {...contentSwap}
                      checked={!paused}
                      onCheckedChange={onLiveChange}
                      title="关闭后冻结显示，后台继续采集；采集结束后自动显示完整结果。"
                    >
                      实时更新{paused && unseen > 0 ? `（+${unseen}）` : ""}
                    </Switch>
                  )}
                </AnimatePresence>
                <Button
                  variant={
                    (pending ? captureAction === "stop" : capturing)
                      ? "secondary"
                      : "primary"
                  }
                  className="min-h-7.5 px-2.5 py-1.5 text-[12px] whitespace-nowrap transition-none"
                  style={{ width: 96 }}
                  whileTap={{}}
                  status={pending ? "pending" : "idle"}
                  icon={
                    (pending ? captureAction === "stop" : capturing) ? (
                      <Square size={14} />
                    ) : (
                      <Play size={14} />
                    )
                  }
                  disabled={pending || !connected || (!capturing && !ready)}
                  onClick={() => {
                    capture(capturing ? "stop" : "start").catch(
                      (backgroundError: unknown) => {
                        console.error(
                          "CaptureControls: capture failed",
                          backgroundError,
                        );
                      },
                    );
                  }}
                >
                  {pending
                    ? confirming
                      ? "等待同步"
                      : captureAction === "stop"
                        ? "正在停止"
                        : "正在启动"
                    : capturing
                      ? "停止采集"
                      : run
                        ? "重新采集"
                        : "开始采集"}
                </Button>
                {run && (
                  <a
                    draggable={false}
                    className={twMerge(
                      buttonStyles.base,
                      buttonStyles.secondary,
                      "hover:bg-sidebar min-h-7.5 py-1.5 px-2.5 text-[12px] whitespace-nowrap",
                    )}
                    href="/api/mijia/logs/download"
                    download
                    title="导出本次采集的全部原始日志"
                  >
                    <Download size={14} className="shrink-0" />
                    导出
                  </a>
                )}
              </div>
            </>
          )}
        </fieldset>
      </PageHeaderContent>
      {error && <Notice tone="error">{error}</Notice>}
      {loaded && !connected && (
        <StatusNotice tone="warning">
          页面连接恢复中，后台采集不受页面断线影响。
        </StatusNotice>
      )}
      {!ready && !capturing && (
        <Notice tone="neutral">家庭设备连接就绪后，即可开始采集。</Notice>
      )}
      {run?.reason && run.reason !== "手动停止" && (
        <StatusNotice tone={run.status === "error" ? "error" : "warning"}>
          {run.reason}
        </StatusNotice>
      )}
      {!!run?.failed_topics && (
        <Notice tone="error">
          {run.failed_topics}{" "}
          项订阅失败，部分设备可能无法收到上报。切换到连接与订阅查看详情。
        </Notice>
      )}
      {capturing && run.connection !== "connected" && (
        <Notice tone="error">
          设备推送连接尚未就绪或已断开，这段时间可能漏报。
        </Notice>
      )}
    </>
  );
}
