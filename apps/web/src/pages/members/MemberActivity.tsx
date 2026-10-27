import { formatTime } from "../../modules/presentation/time";
import {
  type memberActivityDataSchema,
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
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, ChevronDown, Clock3, RefreshCw } from "lucide-react";
import type { Member } from "../../modules/members/queries";
import {
  groupMemberActivities,
  memberActivityOptions,
} from "../../modules/members/activity";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { Skeleton } from "../../components/Skeleton";
import { requestErrorMessage } from "../../messages/zh-CN";

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

function ObservationAttribution({
  data,
}: {
  data: ReturnType<typeof memberActivityDataSchema.parse>;
}) {
  const { attribution } = data;
  const correction = attribution.lastCorrection;
  return (
    <div className="space-y-4">
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
  );
}

function ActivityAttribution({
  records,
}: {
  records: ReturnType<typeof groupMemberActivities>[number]["records"];
}) {
  const [open, setOpen] = useState(false);
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
        <div className="mt-3 divide-y divide-line border-t border-line">
          {records.map(({ id, data }) =>
            data ? (
              <div key={id} className="space-y-3 py-4">
                {records.length > 1 ? (
                  <p className="font-medium tabular-nums text-ink">
                    {formatTime(data.firstObservedAt, "clock")}–
                    {formatTime(data.lastObservedAt, "clock")}
                  </p>
                ) : null}
                <ObservationAttribution data={data} />
              </div>
            ) : null,
          )}
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
  const [refreshing, setRefreshing] = useState(false);
  const client = useQueryClient();
  const options = memberActivityOptions(scope, member);
  const query = useInfiniteQuery(options);
  const activityEntries = useMemo(
    () =>
      groupMemberActivities(
        query.data?.pages.flatMap((page) => page.rows) ?? [],
      ),
    [query.data],
  );
  const playableActivities = useMemo(
    () =>
      activityEntries.flatMap(({ id, source, records }) =>
        source
          ? [
              {
                id,
                source,
                recordingAt:
                  records.length > 1
                    ? source.firstObservedAt
                    : source.lastObservedAt,
              },
            ]
          : [],
      ),
    [activityEntries],
  );
  const playback = useObservationPlayback(playableActivities, scope);
  async function refresh() {
    setRefreshing(true);
    try {
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      client.setQueryData(
        options.queryKey,
        (data) =>
          data
            ? {
                ...data,
                pages: data.pages.slice(0, 1),
                pageParams: data.pageParams.slice(0, 1),
              }
            : data,
        { updatedAt: query.dataUpdatedAt },
      );
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
            可能与{member.name}有关的连续观察，最新记录在前。
          </p>
          {(query.data?.pages.length ?? 0) > 1 ? (
            <p className="mt-1.5 text-xs text-muted">
              浏览历史时暂停自动刷新，刷新记录可回到最新。
            </p>
          ) : null}
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
          {activityEntries.length ? (
            <ol className="space-y-3">
              {activityEntries.map(
                ({
                  id,
                  representative,
                  source,
                  records,
                  startedAt,
                  endedAt,
                }) => {
                  const { row, data: parsed } = representative;
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
                  const endStyle =
                    formatTime(startedAt, "monthDay") ===
                    formatTime(endedAt, "monthDay")
                      ? "clock"
                      : "monthDayTime";
                  return (
                    <li
                      key={id}
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
                            {row.kind === "assessment"
                              ? "判断记录"
                              : "观察记录"}
                          </span>
                        )}
                        <time
                          className="tabular-nums"
                          dateTime={
                            Number.isFinite(startedAt)
                              ? new Date(startedAt).toISOString()
                              : undefined
                          }
                        >
                          {formatTime(startedAt, "monthDayTime")}
                          {parsed && endedAt > startedAt
                            ? `–${formatTime(endedAt, endStyle)}`
                            : ""}
                        </time>
                      </header>
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <p className="min-w-0 whitespace-pre-wrap break-words text-sm font-medium leading-7">
                          {description}
                        </p>
                        {certainty ? (
                          <span className="text-xs text-muted">
                            {certainty}
                          </span>
                        ) : null}
                        {records.length > 1 ? (
                          <span className="text-xs text-muted">
                            {records.length} 条观察
                          </span>
                        ) : null}
                        {records.every(
                          (record) =>
                            typeof record.row.expiresAt === "string" &&
                            Date.parse(record.row.expiresAt) <=
                              query.dataUpdatedAt,
                        ) ? (
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
                                availability={playback.get(id)}
                              />
                            </div>
                          ) : null}
                          {parsed ? (
                            <ActivityAttribution records={records} />
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                },
              )}
            </ol>
          ) : (
            <div className="flex min-h-40 items-center justify-center gap-3 rounded-xl bg-white p-6 text-muted">
              <Clock3 size={20} strokeWidth={1.5} />
              <div>
                <p className="text-sm">还没有相关活动记录</p>
                <p className="mt-1.5 text-xs">
                  摄像头拍到可能是{member.name}的目标后，观察记录会显示在这里。
                </p>
              </div>
            </div>
          )}
          {query.hasNextPage ? (
            <div className="flex justify-center px-3 pb-1 pt-3">
              <Button
                size="small"
                disabled={query.isFetching}
                onClick={() => {
                  query.fetchNextPage().catch((error: unknown) => {
                    console.error(
                      "Member activity history loading failed",
                      error,
                    );
                  });
                }}
              >
                {query.isFetchingNextPage ? "正在加载…" : "更早记录"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
