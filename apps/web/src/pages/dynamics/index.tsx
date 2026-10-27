import { useEffect, useId, useState } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { Popover } from "radix-ui";
import { useAtomValue } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  AudioLines,
  Check,
  ChevronDown,
  Clock3,
  CircleAlert,
  X,
  LoaderCircle,
  Video,
} from "lucide-react";
import { householdScopeEpochAtom } from "../../modules/household/state";
import { householdReliableAtom } from "../../modules/household/sync";
import { HouseholdAccess } from "../../modules/household/HouseholdAccess";
import {
  useDynamicsSnapshot,
  useDynamicsHistory,
  type AnalysisEntry,
  type AnalysisSummary,
} from "../../modules/dynamics/queries";
import { formatTime } from "../../modules/presentation/time";
import { MarkdownAnswer } from "../../components/agent/MarkdownAnswer";
import { Button } from "../../components/Button";
import { Notice, StatusNotice } from "../../components/Notice";
import { EmptyState } from "../../components/EmptyState";
import { Skeleton } from "../../components/Skeleton";
import { PageHeaderContent } from "../../components/PageHeaderContent";
import { requestErrorMessage } from "../../messages/zh-CN";
import { AnalysisDetail } from "./AnalysisDetail";

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
        {formatTime(entry.startedAt, "monthDayTime")} —{" "}
        {formatTime(entry.endedAt, "clock")}
      </time>
    </p>
  );
}

function ActiveCard({ entry }: { entry: AnalysisSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="overflow-hidden rounded-2xl bg-white shadow-surface">
      <button
        type="button"
        className="flex w-full items-center gap-4 p-5 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
        aria-expanded={open}
        aria-controls={`analysis-${entry.id}`}
        onClick={() => setOpen(!open)}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface">
          <LoaderCircle
            size={18}
            className="animate-spin motion-reduce:animate-none"
          />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-3 text-sm font-medium">
            <MediaLabel entry={entry} />
            <span className="text-xs font-normal text-muted">
              {entry.status === "preparing"
                ? "正在准备媒体"
                : entry.status === "saving"
                  ? "正在保存"
                  : "正在分析"}
            </span>
          </div>
          <EntryMeta entry={entry} />
        </div>
        <ChevronDown
          size={17}
          className={open ? "rotate-180" : ""}
          aria-hidden="true"
        />
      </button>
      <div id={`analysis-${entry.id}`}>
        {open ? <AnalysisDetail entry={entry} /> : null}
      </div>
    </article>
  );
}

function OriginalRecordingLink({
  entry,
}: {
  entry: Pick<AnalysisEntry, "source" | "startedAt" | "endedAt">;
}) {
  return (
    <Link
      to="/cameras/$deviceId/$channel"
      params={{
        deviceId: entry.source.deviceId,
        channel: String(entry.source.channel),
      }}
      search={{
        returnTo: "/dynamics",
        mode: "windows",
        window: undefined,
        rangeStart: entry.startedAt,
        rangeEnd: entry.endedAt,
        activityRun: undefined,
        member: undefined,
        activityFirstAt: undefined,
        activityAt: undefined,
      }}
      className="shrink-0 rounded-sm py-2 text-xs text-muted underline underline-offset-4 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4"
    >
      查看原片
    </Link>
  );
}

function AnalysisPool({
  entries,
  kind,
}: {
  entries: AnalysisSummary[];
  kind: "queue" | "failed";
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const reduced = useReducedMotion();
  const label = kind === "queue" ? "待分析池" : "未完成的分析";
  const Icon = kind === "queue" ? Clock3 : CircleAlert;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${label}，${entries.length} 项`}
          title={`${label} · ${entries.length}`}
          className={`flex size-10 shrink-0 items-center justify-center gap-1 rounded-full text-xs tabular-nums outline-offset-4 transition-colors hover:bg-sidebar data-[state=open]:bg-sidebar ${kind === "failed" ? "bg-warning/7 text-warning" : "bg-surface text-muted"}`}
        >
          <Icon size={13} aria-hidden="true" />
          <span>{entries.length}</span>
        </button>
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
                  <Popover.Close
                    aria-label={`关闭${label}`}
                    className="grid size-7 place-items-center rounded-full text-muted hover:bg-surface"
                  >
                    <X size={14} />
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
                        {kind === "failed" ? (
                          <>
                            <p className="break-words text-xs leading-6 text-muted">
                              {entry.error}
                            </p>
                            {entry.summary ? (
                              <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-6">
                                {entry.summary}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <p className="text-xs text-muted">
                            {entry.status === "collecting"
                              ? "收集中"
                              : "排队中"}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="py-4 text-xs text-muted">
                    没有等待分析的音视频。
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

function CompletedCard({ entry }: { entry: AnalysisEntry }) {
  return (
    <article className="rounded-2xl bg-white p-5 shadow-surface">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-xs text-muted">
            <Check size={13} aria-hidden="true" /> 分析完成{" "}
            <span className="ml-2">
              <MediaLabel entry={entry} />
            </span>
          </p>
          <EntryMeta entry={entry} />
        </div>
        <OriginalRecordingLink entry={entry} />
      </header>
      <MarkdownAnswer>{entry.reply}</MarkdownAnswer>
    </article>
  );
}

function DynamicsContent({ scope }: { scope: string }) {
  const stream = useDynamicsSnapshot();
  const history = useDynamicsHistory(scope);
  const queryClient = useQueryClient();
  const entries = stream.data?.entries ?? [];
  const queued = entries.filter((entry) =>
    ["collecting", "queued"].includes(entry.status),
  );
  const active = entries.filter((entry) =>
    ["preparing", "analyzing", "saving"].includes(entry.status),
  );
  const failed = entries.filter((entry) =>
    ["failed", "expired"].includes(entry.status),
  );
  const completedRevision = entries
    .filter((entry) => entry.status === "completed")
    .map((entry) => `${entry.id}:${entry.completedAt}`)
    .join(",");
  useEffect(() => {
    if (!completedRevision) return;
    queryClient
      .invalidateQueries({ queryKey: ["dynamics-history", scope] })
      .catch((error) =>
        console.error("Dynamics history refresh failed", error),
      );
  }, [queryClient, scope, completedRevision]);
  const completed = [
    ...new Map(
      history.data?.pages
        .flatMap((page) => page.entries)
        .map((entry) => [entry.id, entry]),
    ).values(),
  ];
  return (
    <div className="mx-auto max-w-6xl space-y-7 pb-8">
      <PageHeaderContent slot="actions">
        <div className="flex items-center gap-2">
          <AnalysisPool entries={queued} kind="queue" />
          {failed.length ? (
            <AnalysisPool entries={failed} kind="failed" />
          ) : null}
        </div>
      </PageHeaderContent>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          家里的画面、声音，以及它们正在发生的变化。
        </p>
        <output className="inline-flex items-center gap-2 text-xs text-muted">
          <span
            className={`size-1.5 rounded-full ${stream.connected ? "bg-emerald-500" : "bg-amber-500"}`}
          />
          {stream.connected ? "实时更新中" : "正在连接"}
        </output>
      </div>
      {stream.error ? <Notice tone="warning">{stream.error}</Notice> : null}
      {stream.data?.enabled === false ? (
        <Notice>媒体分析尚未启用。启用后，新的音视频会进入待分析池。</Notice>
      ) : null}
      <section aria-labelledby="dynamics-active" className="space-y-3">
        <h2 id="dynamics-active" className="text-sm font-medium">
          正在分析
          <span className="ml-2 text-xs font-normal tabular-nums text-muted">
            {active.length}
          </span>
        </h2>
        {active.length ? (
          active.map((entry) => <ActiveCard key={entry.id} entry={entry} />)
        ) : (
          <p className="rounded-2xl border border-dashed border-line px-5 py-6 text-sm text-muted">
            {stream.data ? "当前没有正在分析的音视频。" : "正在同步分析状态…"}
          </p>
        )}
      </section>
      <section aria-labelledby="dynamics-completed" className="space-y-3">
        <h2 id="dynamics-completed" className="text-sm font-medium">
          已完成动态
          <span className="ml-2 text-xs font-normal tabular-nums text-muted">
            {completed.length}
          </span>
        </h2>
        {history.error ? (
          <Notice tone="error">
            {requestErrorMessage(history.error)}
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                history
                  .refetch()
                  .catch((error) =>
                    console.error("Dynamics history refresh failed", error),
                  );
              }}
            >
              重试
            </Button>
          </Notice>
        ) : null}
        {history.isPending ? (
          <Skeleton className="h-44 rounded-2xl" aria-label="正在读取动态" />
        ) : completed.length ? (
          completed.map((entry) => (
            <CompletedCard key={entry.id} entry={entry} />
          ))
        ) : !history.error ? (
          <EmptyState
            icon={<Activity size={23} />}
            title="还没有分析完成的动态"
            description="新的音视频分析完成后，会按发生时间显示在这里。"
          />
        ) : null}
        {history.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              disabled={history.isFetchingNextPage}
              onClick={() => {
                history
                  .fetchNextPage()
                  .catch((error) =>
                    console.error("Dynamics history loading failed", error),
                  );
              }}
            >
              {history.isFetchingNextPage ? "正在加载…" : "加载更早动态"}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default function DynamicsPage() {
  const scope = useAtomValue(householdScopeEpochAtom);
  const reliable = useAtomValue(householdReliableAtom);
  return (
    <HouseholdAccess fallback={<Skeleton className="h-80 rounded-2xl" />}>
      {scope && reliable ? (
        <DynamicsContent key={scope} scope={scope} />
      ) : (
        <StatusNotice>正在同步家庭信息…</StatusNotice>
      )}
    </HouseholdAccess>
  );
}
