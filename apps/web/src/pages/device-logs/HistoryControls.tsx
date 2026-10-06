import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "../../components/Button";
import { Notice, StatusNotice } from "../../components/Notice";
import { PageHeaderContent } from "../../components/PageHeaderContent";
import { requestErrorMessage } from "../../messages/zh-CN";
import { exportDeviceHistory } from "../../modules/device-history/export";
import { HistoryRange } from "./HistoryRange";
import type { useDeviceHistory } from "../../modules/device-history/use-device-history";

export function HistoryControls({
  history,
  queryKey,
  range,
  onRangeChange,
  live,
  onResume,
  ready,
  hasMatches,
  selectedRange,
}: {
  history: ReturnType<typeof useDeviceHistory>;
  queryKey: string;
  range: ComponentProps<typeof HistoryRange>["range"];
  onRangeChange: ComponentProps<typeof HistoryRange>["onChange"];
  live: boolean;
  onResume: () => void;
  ready: boolean;
  hasMatches: boolean;
  selectedRange: ComponentProps<typeof HistoryRange>["selected"];
}) {
  const exportController = useRef<AbortController | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportCount, setExportCount] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);

  const [exportQueryKey, setExportQueryKey] = useState(queryKey);
  if (exportQueryKey !== queryKey) {
    setExportQueryKey(queryKey);
    setExporting(false);
    setExportCount(0);
    setExportError(null);
  }

  useEffect(() => {
    return () => {
      const controller = exportController.current;
      exportController.current = null;
      controller?.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A changed filter cancels the export without remounting the toolbar.
  }, [queryKey]);

  useEffect(() => {
    if (!ready || !hasMatches) exportController.current?.abort();
  }, [ready, hasMatches]);

  async function download() {
    if (
      !ready ||
      !hasMatches ||
      !history.displayInput ||
      exportController.current
    )
      return;
    const controller = new AbortController();
    const input = { ...history.displayInput, cursor: undefined };
    exportController.current = controller;
    setExporting(true);
    setExportCount(0);
    setExportError(null);
    try {
      const blob = await exportDeviceHistory(
        input,
        controller.signal,
        (count) => {
          if (exportController.current === controller) setExportCount(count);
        },
      );
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      try {
        link.href = url;
        link.download = `device-history-${input.start.slice(0, 19).replaceAll(":", "-")}-changes.jsonl`;
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setExportError(requestErrorMessage(error));
    } finally {
      if (exportController.current === controller) {
        exportController.current = null;
        setExporting(false);
      }
    }
  }

  return (
    <>
      <PageHeaderContent slot="actions">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <HistoryRange
            range={range}
            live={live}
            ready={ready}
            selected={selectedRange}
            onChange={onRangeChange}
          />
          {!live ? (
            <Button size="small" disabled={!ready} onClick={onResume}>
              返回最新记录
            </Button>
          ) : null}
          {hasMatches && history.error ? (
            <Button
              size="small"
              icon={<RefreshCw size={14} />}
              status={history.isFetching ? "pending" : "idle"}
              disabled={!ready}
              onClick={() => {
                history.refresh();
              }}
            >
              重试
            </Button>
          ) : null}
          <Button
            size="small"
            icon={<Download size={14} />}
            status={exporting ? "pending" : "idle"}
            disabled={!ready || !hasMatches || !history.displayInput}
            title="导出当前显示结果对应时间范围和设备／类型筛选下的全部已保存报告"
            pendingAction={{
              label: "取消导出",
              onClick: () => {
                exportController.current?.abort();
              },
            }}
            onClick={async () => {
              await download();
            }}
          >
            导出
          </Button>
        </div>
      </PageHeaderContent>
      {hasMatches && history.error && (
        <Notice tone="error">{requestErrorMessage(history.error)}</Notice>
      )}
      {live && hasMatches && history.reconnecting && (
        <StatusNotice className="mb-0 mt-3">
          实时连接已中断，正在恢复。当前结果保留，恢复后更新最新一页。
        </StatusNotice>
      )}
      {exportError && <Notice tone="error">{exportError}</Notice>}
      {exporting && (
        <StatusNotice className="mb-0 mt-3">
          正在导出，已读取 {exportCount} 条历史记录。
        </StatusNotice>
      )}
      {!ready ? (
        <Notice className="mb-0 mt-3">
          家庭设备连接就绪后，即可查询设备历史。
        </Notice>
      ) : null}
    </>
  );
}
