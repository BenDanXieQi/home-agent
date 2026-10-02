import { memo, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Button } from "../../components/Button";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import type { createPerceptionSourceState } from "../../modules/perception/source-state";
import {
  windowListOptions,
  windowQueryScope,
  windowRequestUnavailable,
  type WindowListEntry,
} from "../../modules/perception/windows";
import { useWindowMediaState } from "../../modules/perception/use-window-input-state";
import {
  windowTime,
  visualReasons,
  recordingStates,
  candidateLabel,
} from "./window-presentation";
import { WindowDetail } from "./WindowDetail";

export function CameraWindows({
  source,
  scope,
}: {
  source: ReturnType<typeof createPerceptionSourceState>;
  scope: string;
}) {
  const active = useAtomValue(source.accessibleAtom);
  const device = useAtomValue(source.deviceAtom);
  const client = useQueryClient();
  const query = useQuery({
    ...windowListOptions({ scopeEpoch: scope, ...source.target }),
    enabled: (cached) =>
      active && !windowRequestUnavailable(cached.state.error),
  });
  useEffect(() => {
    if (active) return;
    // A lost subscription pauses requests without releasing the selected local media.
    // TanStack owns cancellation failures and always resolves this Promise.
    // oxlint-disable-next-line typescript/no-floating-promises
    client.cancelQueries({ queryKey: windowQueryScope(scope) });
  }, [active, client, scope]);
  const [selection, select] = useState<WindowListEntry>();
  const [onlyPassed, setOnlyPassed] = useState(true);
  const [visibleCount, setVisibleCount] = useState(50);
  const windows = query.data?.windows ?? [];
  const selected =
    windows.find((entry) => entry.id === selection?.id) ?? selection;
  const visibleWindows = windows.filter(
    (entry) => !onlyPassed || entry.gate.candidate !== "none",
  );
  return (
    <section aria-label="筛选片段" className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">
          {device?.name ?? "摄像头"} · 镜头 {source.target.channel}
          {device?.room_name ? ` · ${device.room_name}` : ""}
        </h2>
        <p className="mt-1 text-sm font-medium">筛选片段</p>
        <p className="mt-1 text-sm leading-6 text-muted">
          按本机接收时间汇总，通常每 4
          秒一段。通过仅表示本地筛选结果，不代表识别出活动。通过的片段自动保存，最长保留
          30 分钟、全部摄像头合计最多 1
          GiB，超限先清理最旧片段。已打开的片段不会被新片段打断。
        </p>
      </div>
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 shrink-0 rounded-sm p-0 accent-ink"
          checked={onlyPassed}
          onChange={(event) => setOnlyPassed(event.target.checked)}
        />
        <span>只看通过筛选的片段</span>
      </label>
      {!active ? (
        <StatusNotice>
          正在恢复家庭连接，已打开的片段仍可查看；连接恢复后继续更新。
        </StatusNotice>
      ) : query.isPending ? (
        <StatusNotice>正在读取窗口…</StatusNotice>
      ) : null}
      {query.isError ? (
        <Notice tone="error">
          窗口读取失败：{requestErrorMessage(query.error)}
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
      ) : null}
      {!query.isPending && !query.isError && visibleWindows.length === 0 ? (
        <StatusNotice>
          {onlyPassed
            ? "当前没有通过筛选的片段。可取消勾选查看被跳过的片段。"
            : "当前镜头暂无保留的片段摘要。"}
        </StatusNotice>
      ) : null}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)]">
        <ul
          aria-label="最近窗口"
          className="max-h-64 lg:max-h-[65dvh] space-y-2 overflow-y-auto rounded-2xl"
        >
          {visibleWindows.slice(0, visibleCount).map((entry) => (
            <WindowRow
              key={entry.id}
              entry={entry}
              selected={entry.id === selection?.id}
              select={select}
            />
          ))}
          {visibleCount < visibleWindows.length ? (
            <li>
              <Button onClick={() => setVisibleCount((count) => count + 50)}>
                显示更早的片段
              </Button>
            </li>
          ) : null}
        </ul>
        {selected ? (
          <WindowDetail
            key={selected.id}
            entry={selected}
            scope={scope}
            active={active}
          />
        ) : (
          <StatusNotice>选择一个片段查看摘要与可用媒体。</StatusNotice>
        )}
      </div>
    </section>
  );
}

const WindowRow = memo(function WindowRow({
  entry,
  selected,
  select,
}: {
  entry: WindowListEntry;
  selected: boolean;
  select: (entry: WindowListEntry) => void;
}) {
  const state = useWindowMediaState(entry.recording);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => select(entry)}
        className="w-full rounded-xl border border-line bg-surface p-3 text-left text-sm hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 aria-pressed:border-ink aria-pressed:bg-ink/5"
      >
        <span className="flex flex-wrap justify-between gap-2 font-medium">
          <span>
            {windowTime(entry.startedAt)} – {windowTime(entry.endedAt)}
          </span>
          <span>{candidateLabel(entry)}</span>
        </span>
        <span className="mt-2 block text-xs text-muted">
          {visualReasons[entry.gate.visual]} ·{" "}
          {entry.gate.audioPassed ? "声音过阈" : "声音未通过"}
        </span>
        <span className="mt-1 block text-xs text-muted">
          {entry.gate.candidate === "none"
            ? "未通过筛选，不保留媒体"
            : state
              ? recordingStates[state]
              : "尚未生成"}
          {entry.incomplete ? " · 不完整窗口" : ""}
        </span>
      </button>
    </li>
  );
});
