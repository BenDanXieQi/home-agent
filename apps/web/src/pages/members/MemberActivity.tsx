import { formatTime } from "../../modules/presentation/time";
import {
  memberActivityDataSchema,
  type memberAttributionSnapshotSchema,
} from "@home-agent/api/contracts";
import { MemberAssociationEvidence } from "../../components/MemberAssociationEvidence";
import {
  attributionLabel,
  attributionObservation,
  attributionReason,
  attributionTime,
  correctionReasons,
  revocationEvidence,
} from "../../modules/members/attribution";
import { useObservationPlayback } from "../../modules/playback/use-observation-playback";
import { useMemo, useState } from "react";
import { ObservationPlaybackLink } from "../../components/ObservationPlaybackLink";
import { observationPlaybackSourceSchema } from "../../modules/playback/observation";
import type { contextCursorSchema } from "@home-agent/api/household-context";
import { useQuery } from "@tanstack/react-query";
import { Camera, ChevronDown, Clock3, RefreshCw } from "lucide-react";
import type { Member } from "../../modules/members/queries";
import { contextBrowseOptions } from "../../modules/household-context/queries";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { Skeleton } from "../../components/Skeleton";
import { requestErrorMessage } from "../../messages/zh-CN";

function displayTime(value: unknown) {
  if (typeof value !== "string") return "时间未知";
  return formatTime(value, "monthDayMinute", "时间未知");
}

function memberSightingData(topic: unknown, data: unknown) {
  if (topic !== "member_sighting") return undefined;
  const parsed = memberActivityDataSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

function AttributionSnapshot({
  label,
  snapshot,
}: {
  label: string;
  snapshot: ReturnType<typeof memberAttributionSnapshotSchema.parse>;
}) {
  return (
    <div className="space-y-1 border-l border-line pl-4">
      <p className="font-medium text-ink">
        {label}：{attributionLabel(snapshot)}
      </p>
      <p>判断更新时间：{attributionTime(snapshot.acceptedAt)}</p>
      {snapshot.kind === "known" ? (
        <MemberAssociationEvidence association={snapshot.association} />
      ) : (
        <>
          <p>{attributionReason(snapshot)}</p>
          <details>
            <summary className="cursor-pointer">来源与技术依据</summary>
            <p>相关观察时间：{attributionTime(snapshot.observedAt)}</p>
            <p>{revocationEvidence(snapshot.trigger)}</p>
          </details>
        </>
      )}
    </div>
  );
}

function ActivityAttribution({
  data,
}: {
  data: ReturnType<typeof memberActivityDataSchema.parse>;
}) {
  const [open, setOpen] = useState(false);
  const { attribution } = data;
  const correction = attribution.lastCorrection;
  return (
    <details
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      className="mt-2 break-words text-xs leading-6 text-muted sm:mt-0"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink sm:absolute sm:right-0 sm:top-3 sm:min-h-8 [&::-webkit-details-marker]:hidden">
        {open ? "收起详情" : "查看详情"}
        <ChevronDown
          size={14}
          strokeWidth={1.5}
          aria-hidden="true"
          className={open ? "rotate-180" : undefined}
        />
      </summary>
      {open ? (
        <div className="mt-3 space-y-4 border-t border-line pt-4">
          <div className="space-y-1.5">
            <p className="font-medium text-ink">判断依据</p>
            {attribution.current.kind === "known" ? (
              <MemberAssociationEvidence
                association={attribution.current.association}
              />
            ) : (
              <p>{attributionReason(attribution.current)}</p>
            )}
          </div>
          {correction ? (
            <div className="space-y-1 border-l-2 border-line pl-3">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-ink">最近一次判断变更</span>
                <span className="tabular-nums">
                  {attributionTime(correction.processedAt)}
                </span>
              </p>
              <p>
                从“{attributionLabel(correction.before)}”改为“
                {attributionLabel(correction.after)}”。
              </p>
            </div>
          ) : null}
          <div className="divide-y divide-line border-t border-line">
            {correction ? (
              <details className="group/history py-1">
                <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
                  判断记录
                  <ChevronDown
                    size={14}
                    strokeWidth={1.5}
                    aria-hidden="true"
                    className="group-open/history:rotate-180"
                  />
                </summary>
                <div className="space-y-4 pb-3 pt-2">
                  <AttributionSnapshot
                    label="首次判断"
                    snapshot={attribution.original}
                  />
                  <AttributionSnapshot
                    label="最近变更前"
                    snapshot={correction.before}
                  />
                  <AttributionSnapshot
                    label="最近变更后"
                    snapshot={correction.after}
                  />
                  <p>变更说明：{correctionReasons[correction.reason]}</p>
                  <p>保留首次判断和最近一次变更，不含完整历史。</p>
                </div>
              </details>
            ) : null}
            <details className="group/source py-1">
              <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
                来源与时间
                <ChevronDown
                  size={14}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className="group-open/source:rotate-180"
                />
              </summary>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 pb-3 pt-2">
                <dt>摄像头</dt>
                <dd className="text-ink">
                  {data.deviceName} · 镜头 {data.channel}
                </dd>
                {data.cameraRoomName ? (
                  <>
                    <dt>登记房间</dt>
                    <dd>{data.cameraRoomName}（摄像头归属）</dd>
                  </>
                ) : null}
                <dt>首次拍到</dt>
                <dd className="tabular-nums">
                  {attributionTime(data.firstObservedAt)}
                </dd>
                <dt>最近拍到</dt>
                <dd className="tabular-nums">
                  {attributionTime(data.lastObservedAt)}
                </dd>
                <dt>判断更新</dt>
                <dd className="tabular-nums">
                  {attributionTime(attribution.current.acceptedAt)}
                </dd>
              </dl>
              {attribution.current.kind === "unknown" ? (
                <p className="pb-3">
                  {revocationEvidence(attribution.current.trigger)}
                </p>
              ) : null}
            </details>
          </div>
        </div>
      ) : null}
    </details>
  );
}

export function MemberActivity({
  member,
  scope,
}: {
  member: Member;
  scope: string;
}) {
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [cursors, setCursors] = useState<
    (ReturnType<typeof contextCursorSchema.parse> | null)[]
  >([null]);
  const query = useQuery({
    ...contextBrowseOptions(
      {
        scope_epoch: scope,
        table: "context_records",
        cursor: cursors[page] ?? null,
        search: "",
        entity: { type: member.kind, id: member.id },
      },
      page,
    ),
    refetchInterval: page === 0 ? 5000 : false,
  });
  const { entries: activityEntries, activities: playableActivities } =
    useMemo(() => {
      const entries = (query.data?.rows ?? []).map((row) => {
        const source =
          row.topic === "member_sighting"
            ? observationPlaybackSourceSchema.safeParse(row.data)
            : undefined;
        return {
          row,
          source:
            source?.success && typeof row.id === "string"
              ? source.data
              : undefined,
          attribution: memberSightingData(row.topic, row.data),
        };
      });
      const activities = entries.flatMap(({ row, source }) =>
        source && typeof row.id === "string" ? [{ id: row.id, source }] : [],
      );
      return { entries, activities };
    }, [query.data?.rows]);
  const playback = useObservationPlayback(playableActivities, scope);
  async function refresh() {
    if (page > 0) {
      setCursors([null]);
      setPage(0);
      return;
    }
    setRefreshing(true);
    try {
      await query.refetch();
    } catch (error) {
      console.error("Member activity refresh failed", error);
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <section aria-labelledby="member-activity-title" className="min-w-0">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="member-activity-title" className="text-sm font-medium">
            最近活动
          </h2>
          <p className="mt-1.5 text-xs text-muted">
            可能与{member.name}有关的观察记录，最新记录在前。
          </p>
        </div>
        <Button
          size="small"
          variant="ghost"
          icon={<RefreshCw size={14} />}
          status={refreshing ? "pending" : "idle"}
          onClick={refresh}
        >
          刷新记录
        </Button>
      </header>
      {query.isError ? (
        <Notice tone="error">
          {requestErrorMessage(query.error)}
          <Button onClick={refresh}>重试</Button>
        </Notice>
      ) : null}
      {query.isPending ? <Skeleton className="h-40 rounded-2xl" /> : null}
      {query.data ? (
        <div>
          {query.data.rows.length ? (
            <ol className="space-y-3">
              {activityEntries.map(({ row, source, attribution: parsed }) => {
                const current = parsed?.attribution.current;
                const memberSighting = row.topic === "member_sighting";
                const certainty = current
                  ? current.kind === "unknown"
                    ? "判断已撤回"
                    : current.association.state === "confirmed"
                      ? "系统已确认"
                      : null
                  : memberSighting
                    ? "身份判断暂不可用"
                    : row.certainty === "tentative"
                      ? "证据不足"
                      : row.certainty === "conflicting"
                        ? "存在冲突"
                        : row.certainty === "supported"
                          ? "有依据"
                          : "尚未确认";
                const description = current
                  ? attributionObservation(current)
                  : memberSighting
                    ? "摄像头观察记录，身份判断暂不可用。"
                    : typeof row.summary === "string"
                      ? row.summary
                      : "记录暂无描述";
                return (
                  <li
                    key={
                      typeof row.id === "string" ? row.id : JSON.stringify(row)
                    }
                    className="min-w-0 rounded-2xl border border-line bg-white p-4 sm:p-5"
                  >
                    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs leading-6 text-muted">
                      {parsed ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Camera
                            size={14}
                            strokeWidth={1.5}
                            aria-hidden="true"
                          />
                          {parsed.cameraRoomName
                            ? `${parsed.cameraRoomName}摄像头`
                            : parsed.deviceName}
                          {` · 镜头 ${parsed.channel}`}
                        </span>
                      ) : (
                        <span>
                          {row.kind === "assessment" ? "判断记录" : "观察记录"}
                        </span>
                      )}
                      <time
                        className="tabular-nums"
                        dateTime={
                          typeof row.occurredAt === "string"
                            ? row.occurredAt
                            : undefined
                        }
                      >
                        {displayTime(row.occurredAt)}
                      </time>
                    </header>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <p className="min-w-0 whitespace-pre-wrap break-words text-sm font-medium leading-7">
                        {description}
                      </p>
                      {certainty ? (
                        <span className="text-xs text-muted">{certainty}</span>
                      ) : null}
                      {typeof row.expiresAt === "string" &&
                      Date.parse(row.expiresAt) <= query.dataUpdatedAt ? (
                        <span className="text-xs text-muted">已过期</span>
                      ) : null}
                    </div>
                    {current?.kind === "unknown" ? (
                      <p className="mt-1 text-xs leading-6 text-muted">
                        {attributionReason(current)}
                      </p>
                    ) : null}
                    {source || parsed ? (
                      <div className="relative mt-4 border-t border-line pt-3">
                        {source ? (
                          <div className={parsed ? "sm:pr-44" : undefined}>
                            <ObservationPlaybackLink
                              source={source}
                              memberId={member.id}
                              availability={
                                typeof row.id === "string"
                                  ? playback.get(row.id)
                                  : undefined
                              }
                            />
                          </div>
                        ) : null}
                        {parsed ? <ActivityAttribution data={parsed} /> : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="flex min-h-40 items-center justify-center gap-3 rounded-xl bg-white p-6 text-muted">
              <Clock3 size={20} strokeWidth={1.5} />
              <div>
                <p className="text-sm">
                  {page ? "这一页没有活动记录" : "还没有相关活动记录"}
                </p>
                <p className="mt-1.5 text-xs">
                  摄像头拍到可能是{member.name}的目标后，观察记录会显示在这里。
                </p>
              </div>
            </div>
          )}
          {page > 0 || query.data.has_more ? (
            <div className="flex items-center justify-between px-3 pb-1 pt-3">
              <span className="text-xs text-muted">第 {page + 1} 页</span>
              <div className="flex gap-2">
                <Button
                  size="small"
                  disabled={page === 0 || query.isFetching}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </Button>
                <Button
                  size="small"
                  disabled={
                    !query.data.next_cursor || query.isFetching || page >= 10000
                  }
                  onClick={() => {
                    if (!query.data.next_cursor) return;
                    setCursors([
                      ...cursors.slice(0, page + 1),
                      query.data.next_cursor,
                    ]);
                    setPage(page + 1);
                  }}
                >
                  更早记录
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
