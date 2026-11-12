import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { Dialog, Popover, Tabs } from "radix-ui";
import { useAtomValue } from "jotai";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AudioLines,
  CircleAlert,
  ChevronDown,
  X,
  LoaderCircle,
  PanelRightOpen,
  TextSearch,
  Video,
} from "lucide-react";
import { householdScopeEpochAtom } from "../../modules/household/state";
import { householdReliableAtom } from "../../modules/household/sync";
import { HouseholdAccess } from "../../modules/household/HouseholdAccess";
import {
  useDynamicsSnapshot,
  mediaAgentHistoryOptions,
  type MediaAgentHistoryEntry,
  type MediaAgentHistoryPage,
  type AnalysisEntry,
  type AnalysisSummary,
} from "../../modules/dynamics/queries";
import { formatTime } from "../../modules/presentation/time";
import { MarkdownAnswer } from "../../components/agent/MarkdownAnswer";
import { Select } from "../../components/Select";
import { Notice, StatusNotice } from "../../components/Notice";
import { EmptyState } from "../../components/EmptyState";
import { Skeleton } from "../../components/Skeleton";
import { PageHeaderContent } from "../../components/PageHeaderContent";
import { SelectionIndicator } from "../../components/SelectionIndicator";
import { Button } from "../../components/Button";
import { AnalysisDetail, AnalysisTiming } from "./AnalysisDetail";
import { OriginalRecordingLink } from "./OriginalRecordingLink";
import { useReadingSnapshot } from "../../utils/use-reading-snapshot";
import { requestErrorMessage } from "../../messages/zh-CN";

function MediaLabel({
  entry,
}: {
  entry: Pick<AnalysisEntry, "kind" | "includeAudio">;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {entry.kind === "video" ? (
        <Video size={13} aria-hidden="true" />
      ) : (
        <AudioLines size={13} aria-hidden="true" />
      )}
      {entry.kind === "video"
        ? entry.includeAudio
          ? "视频 + 音频"
          : "视频"
        : "音频"}
    </span>
  );
}

function EntryMeta({
  entry,
}: {
  entry: Pick<
    AnalysisEntry,
    "startedAt" | "endedAt" | "deviceName" | "location"
  >;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-6 text-muted">
      <span>{entry.location}</span>
      <span aria-hidden="true">·</span>
      <span>{entry.deviceName}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={new Date(entry.startedAt).toISOString()}>
        原片 {formatTime(entry.startedAt, "monthDayTime")} —{" "}
        {formatTime(
          entry.endedAt,
          formatTime(entry.startedAt, "monthDay") ===
            formatTime(entry.endedAt, "monthDay")
            ? "clock"
            : "monthDayTime",
        )}
      </time>
    </p>
  );
}

function ActiveAnalyses({
  entries,
  reading,
}: {
  entries: AnalysisSummary[];
  reading: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected =
    entries.find((entry) => entry.id === selectedId) ?? entries[0];
  if (!selected) return null;

  return (
    <Tabs.Root
      value={selected.id}
      onValueChange={setSelectedId}
      activationMode="manual"
      className="min-w-0"
    >
      <Tabs.List
        aria-label="正在分析的音视频"
        className="mb-4 flex gap-1.5 overflow-x-auto overscroll-x-contain rounded-xl bg-surface p-1.5"
      >
        {entries.map((entry) => (
          <Tabs.Trigger
            key={entry.id}
            value={entry.id}
            className="w-44 shrink-0 space-y-1.5 rounded-lg px-3 py-2.5 text-left text-muted transition-colors hover:bg-white/70 focus-visible:outline-2 focus-visible:outline-offset-[-2px] data-[state=active]:bg-white data-[state=active]:text-ink data-[state=active]:shadow-surface"
          >
            <span
              className="block truncate text-[13px] font-medium"
              title={`${entry.observationTarget ? `${entry.observationTarget.name} · ` : ""}${entry.deviceName} · 镜头 ${entry.source.channel}`}
            >
              {entry.observationTarget
                ? `${entry.observationTarget.name} · `
                : null}
              {entry.deviceName} · 镜头 {entry.source.channel}
            </span>
            <span className="flex items-center gap-2 text-xs text-muted">
              <MediaLabel entry={entry} />
              {!reading ? (
                <LoaderCircle
                  size={12}
                  aria-hidden="true"
                  className="ml-auto shrink-0 animate-spin motion-reduce:animate-none"
                />
              ) : null}
              {reading
                ? "查看中"
                : entry.status === "preparing"
                  ? "准备中"
                  : entry.status === "saving"
                    ? "保存中"
                    : "分析中"}
            </span>
            <span className="block text-xs tabular-nums text-muted">
              原片{" "}
              <time dateTime={new Date(entry.startedAt).toISOString()}>
                {formatTime(entry.startedAt, "monthDayTime")}
              </time>{" "}
              —{" "}
              {formatTime(
                entry.endedAt,
                formatTime(entry.startedAt, "monthDay") ===
                  formatTime(entry.endedAt, "monthDay")
                  ? "clock"
                  : "monthDayTime",
              )}
            </span>
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {entries.map((entry) => (
        <Tabs.Content
          key={entry.id}
          value={entry.id}
          className="focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
        >
          <AnalysisDetail entry={entry} />
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

function AnalysisPool({ entries }: { entries: AnalysisSummary[] }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const reduced = useReducedMotion();
  const label = "未完成或有异常的分析";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="small"
          icon={<CircleAlert size={14} aria-hidden="true" />}
          aria-label={`${label}，${entries.length} 项`}
          title={`${label} · ${entries.length}`}
          className="tabular-nums text-warning data-[state=open]:bg-surface"
        >
          {entries.length}
        </Button>
      </Popover.Trigger>
      <AnimatePresence>
        {open ? (
          <Popover.Portal forceMount>
            <Popover.Content
              forceMount
              asChild
              align="end"
              sideOffset={8}
              collisionPadding={12}
              aria-labelledby={titleId}
            >
              <m.div
                className="z-60 w-96 max-w-[calc(100vw_-_24px)] origin-(--radix-popover-content-transform-origin) rounded-2xl bg-white p-4 shadow-panel outline-none"
                initial={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{
                  opacity: 0,
                  scale: reduced ? 1 : 0.96,
                  transition: { duration: 0.14 },
                }}
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h2 id={titleId} className="text-sm font-medium">
                    {label}
                    <span className="ml-2 text-xs font-normal tabular-nums text-muted">
                      {entries.length}
                    </span>
                  </h2>
                  <Popover.Close asChild>
                    <Button
                      variant="ghost"
                      size="small"
                      aria-label={`关闭${label}`}
                      icon={<X size={14} />}
                    />
                  </Popover.Close>
                </div>
                {entries.length ? (
                  <ol className="max-h-[min(24rem,var(--radix-popover-content-available-height)_-_4rem)] divide-y divide-line overflow-y-auto overscroll-contain">
                    {entries.map((entry) => (
                      <li key={entry.id} className="space-y-1 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs">
                            <MediaLabel entry={entry} />
                          </span>
                          <OriginalRecordingLink entry={entry} />
                        </div>
                        <EntryMeta entry={entry} />
                        <AnalysisTiming entry={entry} />
                        <p className="break-words text-xs leading-6 text-muted">
                          {entry.error}
                        </p>
                        {entry.summary ? (
                          <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-6">
                            {entry.summary}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="py-4 text-xs text-muted">
                    没有未完成或有异常的分析。
                  </p>
                )}
              </m.div>
            </Popover.Content>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}

function AnalysisTasks({
  entries,
  observationTargets,
  container,
  loading,
}: {
  entries: AnalysisSummary[];
  observationTargets: NonNullable<AnalysisSummary["observationTarget"]>[];
  container: HTMLElement | null;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("active");
  const [target, setTarget] = useState("");
  const selectionId = useId();
  const reduced = useReducedMotion();
  const tasks = entries.filter((entry) =>
    ["collecting", "queued", "preparing", "analyzing", "saving"].includes(
      entry.status,
    ),
  );
  const targets = new Map(
    [
      ...observationTargets,
      ...tasks.flatMap((entry) =>
        entry.observationTarget ? [entry.observationTarget] : [],
      ),
    ].map((observation) => [observation.id, observation]),
  );
  const options = [
    { value: "", label: "全部房间" },
    ...[...targets.values()]
      .toSorted((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .map((observation) => ({
        value: observation.id,
        label: observation.name,
      })),
  ];
  const selectedTarget = targets.has(target) ? target : "";
  const visible = tasks.filter(
    (entry) =>
      !selectedTarget || entry.observationTarget?.id === selectedTarget,
  );
  const active = visible.filter((entry) =>
    ["preparing", "analyzing", "saving"].includes(entry.status),
  );
  const { snapshot, freeze, resume } = useReadingSnapshot(
    active,
    JSON.stringify([open, tab, target]),
  );
  const shownActive = snapshot ?? active;

  function keepReading() {
    if (tab === "active" && !snapshot && active.length) freeze();
  }

  const queued = visible
    .filter((entry) => ["queued", "collecting"].includes(entry.status))
    .toSorted((a, b) => b.endedAt - a.endedAt || b.queuedAt - a.queuedAt);
  const collecting = queued.filter(
    (entry) => entry.status === "collecting",
  ).length;
  const totalActive = tasks.filter((entry) =>
    ["preparing", "analyzing", "saving"].includes(entry.status),
  ).length;
  const totalQueued = tasks.filter((entry) => entry.status === "queued").length;
  const totalCollecting = tasks.filter(
    (entry) => entry.status === "collecting",
  ).length;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal={false}>
      <PageHeaderContent slot="actions">
        <Dialog.Trigger asChild>
          <Button
            type="button"
            disabled={loading}
            className="tabular-nums data-[state=open]:bg-sidebar max-md:px-3"
          >
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${tasks.length ? "bg-sage" : "bg-muted/50"}`}
              />
              {loading ? (
                <span>正在同步分析状态</span>
              ) : totalActive || totalQueued ? (
                <span>
                  <span className="max-md:hidden">正在</span>分析 {totalActive}
                  <span className="mx-2 text-muted" aria-hidden="true">
                    ·
                  </span>
                  等待 {totalQueued}
                </span>
              ) : totalCollecting ? (
                <span>收集中 {totalCollecting}</span>
              ) : (
                <span>当前无分析任务</span>
              )}
              <PanelRightOpen size={14} aria-hidden="true" />
            </span>
          </Button>
        </Dialog.Trigger>
      </PageHeaderContent>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount container={container}>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <m.div
                layoutRoot
                className="fixed bottom-3 right-3 top-[calc(var(--workspace-header-height)_+_8px)] z-50 flex w-[min(30rem,calc(100vw_-_24px))] flex-col overflow-hidden rounded-2xl bg-white shadow-panel outline-none max-md:bottom-[calc(88px_+_env(safe-area-inset-bottom))]"
                initial={{
                  opacity: 0,
                  transform: reduced ? "none" : "translateX(100%)",
                }}
                animate={{ opacity: 1, transform: "translateX(0%)" }}
                exit={{
                  opacity: 0,
                  transform: reduced ? "none" : "translateX(100%)",
                }}
                transition={{
                  type: "tween",
                  duration: reduced ? 0 : 0.22,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                <div className="flex shrink-0 items-center justify-between gap-3 px-5 pb-2 pt-4">
                  <Dialog.Title className="text-[13px] font-medium">
                    片段分析
                  </Dialog.Title>
                  {snapshot ? (
                    <Button
                      variant="secondary"
                      size="small"
                      className="ml-auto"
                      title="当前任务列表已固定，分析结果继续实时更新"
                      onClick={resume}
                    >
                      返回最新任务
                    </Button>
                  ) : null}
                  <Dialog.Close asChild>
                    <Button
                      variant="ghost"
                      size="small"
                      aria-label="关闭分析面板"
                      icon={<X size={16} />}
                    />
                  </Dialog.Close>
                </div>
                <Tabs.Root
                  value={tab}
                  onValueChange={setTab}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <div className="shrink-0 space-y-3 border-b border-line px-5 pb-4">
                    <Tabs.List
                      aria-label="分析任务状态"
                      className="flex items-center gap-4 border-b border-line"
                    >
                      <Tabs.Trigger
                        value="active"
                        className="relative isolate shrink-0 whitespace-nowrap py-2.5 text-xs text-muted transition-colors hover:text-ink data-[state=active]:font-semibold data-[state=active]:text-accent"
                      >
                        {tab === "active" ? (
                          <SelectionIndicator
                            layoutId={selectionId}
                            className="inset-x-0 bottom-0 h-0.5 rounded-full"
                          />
                        ) : null}
                        正在分析{" "}
                        <span className="ml-1.5 tabular-nums">
                          {active.length}
                        </span>
                      </Tabs.Trigger>
                      <Tabs.Trigger
                        value="queue"
                        className="relative isolate shrink-0 whitespace-nowrap py-2.5 text-xs text-muted transition-colors hover:text-ink data-[state=active]:font-semibold data-[state=active]:text-accent"
                      >
                        {tab === "queue" ? (
                          <SelectionIndicator
                            layoutId={selectionId}
                            className="inset-x-0 bottom-0 h-0.5 rounded-full"
                          />
                        ) : null}
                        等待分析{" "}
                        <span className="ml-1.5 tabular-nums">
                          {queued.length - collecting}
                        </span>
                        {collecting ? (
                          <span className="ml-2">收集中 {collecting}</span>
                        ) : null}
                      </Tabs.Trigger>
                    </Tabs.List>
                    {options.length > 1 ? (
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="shrink-0 text-xs text-muted">
                          观测房间
                        </span>
                        <Select
                          label="观测房间"
                          value={selectedTarget}
                          onValueChange={setTarget}
                          options={options}
                          className="w-40 max-w-full"
                        />
                      </div>
                    ) : null}
                  </div>
                  <div
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-gutter:stable]"
                    onPointerDownCapture={keepReading}
                    onFocusCapture={keepReading}
                    onPlayCapture={keepReading}
                    onSeekingCapture={keepReading}
                    onWheelCapture={keepReading}
                  >
                    <Tabs.Content
                      value="active"
                      className="focus-visible:outline-2 focus-visible:outline-offset-4"
                    >
                      {shownActive.length ? (
                        <ActiveAnalyses
                          entries={shownActive}
                          reading={snapshot !== null}
                        />
                      ) : (
                        <p className="py-6 text-sm text-muted">
                          当前范围内没有正在分析的音视频。
                        </p>
                      )}
                    </Tabs.Content>
                    <Tabs.Content
                      value="queue"
                      className="focus-visible:outline-2 focus-visible:outline-offset-4"
                    >
                      {queued.length ? (
                        <div>
                          <p className="pb-2 text-xs text-muted">
                            较新片段优先 · 收集完成后进入等待分析
                          </p>
                          <ol className="grid gap-1.5 rounded-2xl bg-surface p-1.5">
                            {queued.map((entry) => (
                              <li
                                key={entry.id}
                                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl bg-white p-3"
                              >
                                <div className="min-w-0 space-y-1">
                                  <p className="text-[13px] font-medium">
                                    {entry.observationTarget
                                      ? `${entry.observationTarget.name} · `
                                      : null}
                                    {entry.deviceName} · 镜头{" "}
                                    {entry.source.channel}
                                  </p>
                                  <EntryMeta entry={entry} />
                                </div>
                                <div className="flex items-center gap-3 text-xs text-muted">
                                  <MediaLabel entry={entry} />
                                  <span>
                                    {entry.status === "collecting"
                                      ? "收集中"
                                      : "等待分析"}
                                  </span>
                                  <OriginalRecordingLink entry={entry} />
                                </div>
                              </li>
                            ))}
                          </ol>
                        </div>
                      ) : (
                        <p className="py-6 text-sm text-muted">
                          当前范围内没有等待分析的音视频。
                        </p>
                      )}
                    </Tabs.Content>
                  </div>
                </Tabs.Root>
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function MediaAgentRecord({ entry }: { entry: MediaAgentHistoryEntry }) {
  const locations = [
    ...new Set(
      entry.recordings.flatMap((recording) =>
        recording.observationTarget ? [recording.observationTarget.name] : [],
      ),
    ),
  ];

  return (
    <article className="min-w-0 space-y-3 rounded-xl bg-white p-4 sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="space-y-1.5">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="font-medium text-ink">媒体 Agent</span>
            {locations.length ? (
              <span>观测房间：{locations.join(" · ")}</span>
            ) : null}
          </p>
          <AnalysisTiming
            entry={{
              analysisStartedAt: entry.startedAt,
              completedAt: entry.completedAt,
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {entry.recordings.map((recording) => (
            <div key={recording.id} className="flex items-center gap-2">
              {entry.recordings.length > 1 ? (
                <span className="text-xs text-muted">
                  {recording.observationTarget?.name ?? recording.deviceName} ·
                  镜头 {recording.source.channel} ·{" "}
                  {formatTime(recording.startedAt, "clock")}
                </span>
              ) : null}
              <OriginalRecordingLink entry={recording} />
            </div>
          ))}
        </div>
      </header>
      {entry.reply ? <MarkdownAnswer>{entry.reply}</MarkdownAnswer> : null}
      {entry.reasoning || entry.recordings.length ? (
        <details className="group/analysis">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 text-xs text-muted outline-offset-4 transition-colors hover:bg-surface hover:text-ink group-open/analysis:bg-surface group-open/analysis:text-ink [&::-webkit-details-marker]:hidden">
            <TextSearch size={14} strokeWidth={1.5} aria-hidden="true" />
            分析详情
            <ChevronDown
              size={12}
              strokeWidth={1.5}
              aria-hidden="true"
              className="transition-transform group-open/analysis:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          <Tabs.Root
            defaultValue={entry.recordings.length ? "analyses" : "thinking"}
            className="mt-3 rounded-xl bg-surface/60 px-4 pb-4"
          >
            <Tabs.List
              aria-label="分析详情"
              className="mb-3 flex items-center gap-5 border-b border-line"
            >
              {entry.recordings.length ? (
                <Tabs.Trigger
                  value="analyses"
                  className="-mb-px border-b-2 border-transparent py-3 text-xs text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-accent"
                >
                  子分析
                </Tabs.Trigger>
              ) : null}
              {entry.reasoning ? (
                <Tabs.Trigger
                  value="thinking"
                  className="-mb-px border-b-2 border-transparent py-3 text-xs text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-accent"
                >
                  思考过程
                </Tabs.Trigger>
              ) : null}
            </Tabs.List>
            {entry.recordings.length ? (
              <Tabs.Content
                value="analyses"
                className="max-h-[min(28rem,60dvh)] overflow-y-auto overscroll-contain pr-1 outline-offset-2 [scrollbar-gutter:stable]"
              >
                <ol className="divide-y divide-line">
                  {entry.recordings.map((recording) => (
                    <li
                      key={recording.id}
                      className="min-w-0 space-y-2 py-4 first:pt-0 last:pb-0"
                    >
                      {recording.question ? (
                        <p className="text-xs leading-6 text-muted">
                          补看核实：{recording.question}
                        </p>
                      ) : null}
                      <MarkdownAnswer>{recording.reply}</MarkdownAnswer>
                      {recording.reasoning ? (
                        <details className="group/child-reasoning">
                          <summary className="flex min-h-7 w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs text-muted outline-offset-4 hover:text-ink [&::-webkit-details-marker]:hidden">
                            分析过程
                            <ChevronDown
                              size={12}
                              strokeWidth={1.5}
                              aria-hidden="true"
                              className="transition-transform group-open/child-reasoning:rotate-180 motion-reduce:transition-none"
                            />
                          </summary>
                          <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-muted">
                            {recording.reasoning}
                          </div>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </Tabs.Content>
            ) : null}
            {entry.reasoning ? (
              <Tabs.Content
                value="thinking"
                className="max-h-[min(28rem,60dvh)] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words pr-1 text-sm leading-7 text-muted outline-offset-2 [scrollbar-gutter:stable]"
              >
                {entry.reasoning}
              </Tabs.Content>
            ) : null}
          </Tabs.Root>
        </details>
      ) : null}
    </article>
  );
}

function DynamicsHistory({ history }: { history: MediaAgentHistoryPage }) {
  const container = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const client = useQueryClient();
  const { snapshot, freeze, resume } = useReadingSnapshot(history, "history");
  const page = snapshot ?? history;
  const options = mediaAgentHistoryOptions(page.nextCursor);
  const older = useInfiniteQuery(options);
  const olderPages = snapshot ? older.data?.pages : undefined;
  const visible = [
    ...new Map(
      [
        ...page.entries,
        ...(olderPages?.flatMap((entry) => entry.entries) ?? []),
      ].map((entry) => [entry.id, entry]),
    ).values(),
  ];
  const visibleIds = new Set(visible.map((entry) => entry.id));
  const pending =
    snapshot !== null &&
    history.entries.some((entry) => !visibleIds.has(entry.id));
  const hasOlder =
    page.nextCursor !== null && (!olderPages || older.hasNextPage);

  function loadOlder() {
    if (!hasOlder || older.isFetching) return;
    if (!snapshot) freeze();
    older.fetchNextPage().catch((error: unknown) => {
      console.error("Media Agent history loading failed", error);
    });
  }

  function resumeLatest() {
    client.removeQueries({ queryKey: options.queryKey, exact: true });
    resume();
  }

  const trackReading = useEffectEvent(() => {
    // Closed outer disclosures may still contain open, hidden disclosures.
    const expanded = container.current?.querySelector(
      "details[open]:not(details details)",
    );
    if (window.scrollY > 1 || expanded) {
      if (!snapshot) freeze();
    } else if (snapshot) {
      resumeLatest();
    }

    if (
      window.scrollY > 1 &&
      !older.isError &&
      container.current &&
      container.current.getBoundingClientRect().bottom <= window.innerHeight * 2
    )
      loadOlder();
  });

  useEffect(() => {
    const element = container.current;
    trackReading();
    window.addEventListener("scroll", trackReading, { passive: true });
    element?.addEventListener("toggle", trackReading, true);
    return () => {
      window.removeEventListener("scroll", trackReading);
      element?.removeEventListener("toggle", trackReading, true);
    };
  }, []);

  return (
    <section
      ref={container}
      aria-labelledby="dynamics-history"
      className="space-y-4"
    >
      {snapshot ? (
        <PageHeaderContent slot="actions">
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              for (const detail of container.current?.querySelectorAll(
                "details[open]",
              ) ?? [])
                detail.removeAttribute("open");
              resumeLatest();
              heading.current?.focus({ preventScroll: true });
              window.scrollTo({ top: 0, behavior: "instant" });
            }}
          >
            返回最新记录{pending ? " · 有新记录" : ""}
          </Button>
        </PageHeaderContent>
      ) : null}
      <div className="flex items-baseline gap-3">
        <h2
          ref={heading}
          id="dynamics-history"
          tabIndex={-1}
          className="text-[13px] font-medium"
        >
          历史动态
        </h2>
        <span className="text-xs text-muted" title="数量仅为当前已加载记录">
          媒体 Agent · {visible.length} 条已加载记录
        </span>
      </div>
      {visible.length ? (
        <div className="grid gap-1.5 rounded-2xl bg-surface p-2">
          {visible.map((entry) => (
            <MediaAgentRecord key={entry.id} entry={entry} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Activity size={23} />}
          title="还没有媒体 Agent 的思考与结论"
          description="媒体 Agent 收到子分析结果后形成的思考和回复会显示在这里。"
        />
      )}
      {snapshot && older.isError ? (
        <Notice tone="error">
          更早记录读取失败：{requestErrorMessage(older.error)}
        </Notice>
      ) : null}
      {visible.length ? (
        hasOlder ? (
          <div className="flex justify-center py-2">
            <Button
              size="small"
              disabled={older.isFetching}
              onClick={loadOlder}
            >
              {older.isFetching
                ? "正在读取更早记录…"
                : older.isError
                  ? "重新读取更早记录"
                  : "查看更早的记录"}
            </Button>
          </div>
        ) : (
          <p className="py-2 text-center text-xs text-muted">没有更早记录</p>
        )
      ) : null}
    </section>
  );
}

function DynamicsContent() {
  const [panelContainer, setPanelContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const stream = useDynamicsSnapshot();
  const entries = stream.data?.entries ?? [];
  const history = stream.data?.history ?? { entries: [], nextCursor: null };
  const failed = entries.filter(
    (entry) =>
      ["failed", "expired", "skipped"].includes(entry.status) ||
      (entry.status === "completed" && !!entry.error),
  );

  return (
    <div ref={setPanelContainer} className="space-y-5 pb-8">
      {failed.length ? (
        <PageHeaderContent slot="actions">
          <AnalysisPool entries={failed} />
        </PageHeaderContent>
      ) : null}
      {stream.error ? <Notice tone="warning">{stream.error}</Notice> : null}
      {stream.data?.enabled === false ? (
        <Notice>媒体分析尚未启用。启用后，新的音视频会进入待分析池。</Notice>
      ) : null}
      <AnalysisTasks
        entries={entries}
        observationTargets={stream.data?.observationTargets ?? []}
        container={panelContainer?.parentElement ?? null}
        loading={!stream.data}
      />
      {!stream.data ? (
        <Skeleton className="h-44 rounded-2xl" aria-label="正在读取动态" />
      ) : (
        <DynamicsHistory history={history} />
      )}
    </div>
  );
}

export default function DynamicsPage() {
  const scope = useAtomValue(householdScopeEpochAtom);
  const reliable = useAtomValue(householdReliableAtom);
  return (
    <HouseholdAccess fallback={<Skeleton className="h-80 rounded-2xl" />}>
      {scope && reliable ? (
        <DynamicsContent key={scope} />
      ) : (
        <StatusNotice>正在同步家庭信息…</StatusNotice>
      )}
    </HouseholdAccess>
  );
}
