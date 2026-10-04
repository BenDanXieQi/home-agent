import { useState } from "react";
import type { contextCursorSchema } from "@home-agent/api/household-context";
import { useQuery } from "@tanstack/react-query";
import { Clock3, RefreshCw } from "lucide-react";
import type { Member } from "../../modules/members/queries";
import { contextBrowseOptions } from "../../modules/household-context/queries";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { Skeleton } from "../../components/Skeleton";
import { requestErrorMessage } from "../../messages/zh-CN";

function displayTime(value: unknown) {
  if (typeof value !== "string") return "时间未知";
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? "时间未知"
    : time.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function MemberActivity({
  member,
  scope,
}: {
  member: Member;
  scope: string;
}) {
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<
    (ReturnType<typeof contextCursorSchema.parse> | null)[]
  >([null]);
  const query = useQuery(
    contextBrowseOptions(
      {
        scope_epoch: scope,
        table: "context_records",
        cursor: cursors[page] ?? null,
        search: "",
        entity: { type: member.kind, id: member.id },
      },
      page,
    ),
  );
  function refresh() {
    query.refetch().catch((error: unknown) => {
      console.error("Member activity refresh failed", error);
    });
  }
  return (
    <section aria-labelledby="member-activity-title" className="min-w-0">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="member-activity-title" className="text-sm font-medium">
            最近活动
          </h2>
          <p className="mt-1.5 text-xs text-muted">
            与{member.name}关联的观察和判断，按时间倒序展示。
          </p>
        </div>
        <Button
          size="small"
          variant="ghost"
          icon={<RefreshCw size={14} />}
          status={query.isFetching ? "pending" : "idle"}
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
      {query.isSuccess ? (
        <div className="rounded-2xl bg-surface p-2">
          {query.data.rows.length ? (
            <ol className="space-y-1">
              {query.data.rows.map((row) => {
                const uncertain = row.certainty !== "supported";
                const certainty =
                  row.certainty === "tentative"
                    ? "可能"
                    : row.certainty === "conflicting"
                      ? "存在冲突"
                      : row.certainty === "supported"
                        ? "有依据"
                        : "尚未确认";
                return (
                  <li
                    key={
                      typeof row.id === "string" ? row.id : JSON.stringify(row)
                    }
                    className="grid gap-3 rounded-xl bg-white px-5 py-4 shadow-surface sm:grid-cols-[120px_minmax(0,1fr)]"
                  >
                    <time
                      className="pt-0.5 text-xs tabular-nums text-muted"
                      dateTime={
                        typeof row.occurredAt === "string"
                          ? row.occurredAt
                          : undefined
                      }
                    >
                      {displayTime(row.occurredAt)}
                    </time>
                    <div className="min-w-0">
                      <div className="mb-2 flex flex-wrap gap-2 text-[11px]">
                        <span className="text-muted">
                          {row.kind === "assessment" ? "判断记录" : "观察记录"}
                        </span>
                        <span
                          className={uncertain ? "text-warning" : "text-sage"}
                        >
                          {certainty}
                        </span>
                        {typeof row.expiresAt === "string" &&
                        Date.parse(row.expiresAt) <= query.dataUpdatedAt ? (
                          <span className="text-muted">已过期</span>
                        ) : null}
                      </div>
                      <p className="max-w-3xl whitespace-pre-wrap break-words text-sm leading-7">
                        {typeof row.summary === "string"
                          ? row.summary
                          : "记录暂无描述"}
                      </p>
                    </div>
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
                <p className="mt-1.5 text-xs">没有记录不代表成员没有活动。</p>
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
