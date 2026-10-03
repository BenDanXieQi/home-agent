import { useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Database, RefreshCw, Search, Link2, X } from "lucide-react";
import { contextBrowseQuerySchema } from "@home-agent/api/household-context";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
} from "../../modules/household/state";
import { HouseholdAccess } from "../../modules/household/HouseholdAccess";
import { contextBrowseOptions } from "../../modules/household-context/queries";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { PageHeaderContent } from "../../components/PageHeaderContent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Notice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import {
  tablePresentation,
  fieldLabels,
  displayCell,
  rowKey,
} from "./presentation";

function DataBrowser({ scope }: { scope: string }) {
  const [input, setInput] = useState(() =>
    contextBrowseQuerySchema.parse({
      scope_epoch: scope,
      table: "context_records",
      page: 0,
      search: "",
    }),
  );
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const [selectedKey, selectKey] = useState<string | null>(null);
  const query = useQuery({
    ...contextBrowseOptions(input),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const displayedInput = data?.request ?? input;
  const table = data?.tables.find((item) => item.name === displayedInput.table);
  const selected = query.isPlaceholderData
    ? undefined
    : data?.rows.find((row) => rowKey(row) === selectedKey);
  const selectedId = typeof selected?.id === "string" ? selected.id : undefined;
  const selectedContextId =
    typeof selected?.contextId === "string" ? selected.contextId : undefined;
  const presentation = tablePresentation[displayedInput.table];
  function searchRecords() {
    setInput({ ...input, page: 0, search: search.trim() });
    selectKey(null);
  }
  function navigate(
    next: Pick<typeof input, "table" | "context_id" | "entity">,
  ) {
    setInput({ scope_epoch: scope, page: 0, search: "", ...next });
    setSearch("");
    selectKey(null);
  }
  return (
    <div>
      <PageHeaderContent slot="details">
        <span className="text-xs text-muted">只读浏览</span>
      </PageHeaderContent>
      <SegmentedControl
        className="mb-5 border-b border-line"
        label="数据表"
        variant="underline"
        value={input.table}
        onValueChange={(name) => navigate({ table: name })}
        options={(
          ["household_subjects", "context_records", "context_entities"] as const
        ).map((name) => ({
          value: name,
          label: `${tablePresentation[name].title} · ${data?.tables.find((item) => item.name === name)?.count.toLocaleString() ?? "—"}`,
        }))}
      />
      <output className="sr-only" aria-atomic="true">
        {query.isFetching
          ? `正在加载${tablePresentation[input.table].title}`
          : query.isError
            ? "数据读取失败，请重试"
            : `${presentation.title}已加载，本页 ${data?.rows.length ?? 0} 条记录`}
      </output>
      <div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 max-md:grid-cols-1 max-md:gap-2">
        <span className="flex min-h-10 items-center text-xs leading-5 text-muted">
          {query.isPlaceholderData
            ? `正在加载${tablePresentation[input.table].title}，当前显示${presentation.title}`
            : query.isFetching
              ? `正在更新${presentation.title}…`
              : table
                ? `${table.count.toLocaleString()} 条记录`
                : "暂无记录数量"}
        </span>
        <form
          className="flex min-w-0 items-center gap-2 max-md:w-full"
          onSubmit={(event) => {
            event.preventDefault();
            searchRecords();
          }}
        >
          <label className="relative m-0 flex w-60 items-center max-md:w-auto max-md:min-w-0 max-md:flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 text-muted"
            />
            <input
              ref={searchInput}
              className="h-10 pl-9 text-[13px]"
              aria-label={
                input.table === "household_subjects"
                  ? "搜索名称"
                  : input.table === "context_records"
                    ? "搜索描述或主题"
                    : "搜索对象 ID"
              }
              value={search}
              maxLength={100}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={
                input.table === "household_subjects"
                  ? "搜索名称"
                  : input.table === "context_records"
                    ? "搜索描述或主题"
                    : "搜索对象 ID"
              }
            />
          </label>
          <Button type="submit">搜索</Button>
          <Button
            type="button"
            variant="ghost"
            aria-label="刷新数据"
            title="刷新数据"
            icon={<RefreshCw size={14} />}
            status={query.isFetching ? "pending" : "idle"}
            onClick={() => {
              query.refetch().catch(() => {
                console.warn("Context browser refresh failed");
              });
            }}
          />
        </form>
      </div>
      <section aria-label={presentation.title} aria-busy={query.isFetching}>
        {query.isError && data ? (
          <Notice tone="warning">
            更新失败，当前保留上次读取的内容：{requestErrorMessage(query.error)}
          </Notice>
        ) : null}
        {table ? (
          <details
            key={table.name}
            className="mb-4 rounded-xl border border-line p-4 text-sm"
          >
            <summary className="cursor-pointer font-medium focus-visible:outline-2">
              字段结构 · {table.columns.length} 列
            </summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full whitespace-nowrap text-left text-xs">
                <caption className="sr-only">
                  {presentation.title}字段结构
                </caption>
                <thead className="text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2">
                      字段
                    </th>
                    <th scope="col" className="px-3 py-2">
                      列名
                    </th>
                    <th scope="col" className="px-3 py-2">
                      类型
                    </th>
                    <th scope="col" className="px-3 py-2">
                      允许空值
                    </th>
                    <th scope="col" className="px-3 py-2">
                      主键
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {table.columns.map((column) => (
                    <tr key={column.key}>
                      <th scope="row" className="px-3 py-2 font-medium">
                        {fieldLabels[column.key] ?? column.name}
                      </th>
                      <td className="px-3 py-2 font-mono">{column.name}</td>
                      <td className="px-3 py-2 font-mono">{column.type}</td>
                      <td className="px-3 py-2">
                        {column.nullable ? "是" : "否"}
                      </td>
                      <td className="px-3 py-2">
                        {column.primary ? "是" : "否"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
        {displayedInput.context_id || displayedInput.entity ? (
          <div className="flex flex-wrap items-center gap-2 mb-4 rounded-xl bg-surface px-4 py-3 text-xs">
            <Link2 size={14} />
            <span className="break-all">
              筛选：
              {displayedInput.context_id
                ? `上下文 ${displayedInput.context_id}`
                : `${displayedInput.entity?.type} · ${displayedInput.entity?.id}`}
            </span>
            <Button
              size="small"
              variant="ghost"
              disabled={query.isFetching}
              onClick={() => {
                setInput({
                  scope_epoch: scope,
                  table: input.table,
                  page: 0,
                  search: input.search,
                });
                selectKey(null);
                searchInput.current?.focus();
              }}
            >
              清除关联筛选
            </Button>
          </div>
        ) : null}
        <div className="overflow-hidden rounded-2xl bg-surface p-2">
          {query.isError && !data ? (
            <div className="grid min-h-64 items-center rounded-xl bg-white p-5">
              <Notice tone="error">
                数据暂时无法读取：{requestErrorMessage(query.error)}
                <Button
                  size="small"
                  onClick={() => {
                    query.refetch().catch(() => {
                      console.warn("Context browser retry failed");
                    });
                  }}
                >
                  重试
                </Button>
              </Notice>
            </div>
          ) : query.isPending ? (
            <output className="grid min-h-64 place-items-center rounded-xl bg-white px-8 py-10 text-sm text-muted">
              正在读取数据库…
            </output>
          ) : !data?.rows.length ? (
            <EmptyState
              layout="stable"
              icon={<Database size={24} />}
              title={
                displayedInput.search ||
                displayedInput.context_id ||
                displayedInput.entity
                  ? "没有匹配的记录"
                  : `还没有${presentation.title}数据`
              }
              description={
                displayedInput.search ||
                displayedInput.context_id ||
                displayedInput.entity
                  ? "试试其他关键词，或清除筛选条件。"
                  : displayedInput.table === "household_subjects"
                    ? "在成员页添加家人或宠物后，可以在这里查看已保存的资料。"
                    : "上下文自动写入尚未接入，现有房间分析不会自动出现在这里。"
              }
            >
              {displayedInput.search ? (
                <Button
                  disabled={query.isFetching}
                  onClick={() => {
                    setInput({ ...input, page: 0, search: "" });
                    setSearch("");
                    selectKey(null);
                    searchInput.current?.focus();
                  }}
                >
                  清除搜索
                </Button>
              ) : null}
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-left text-sm">
                <caption className="sr-only">
                  {presentation.title}，第 {displayedInput.page + 1} 页
                </caption>
                <thead className="bg-surface text-xs text-muted">
                  <tr>
                    <th className="px-5 py-3">详情</th>
                    {table?.columns.map((column) => (
                      <th key={column.key} className="px-4 py-3 font-medium">
                        <span>{fieldLabels[column.key] ?? column.name}</span>
                        <span className="mt-1 block font-mono text-[10px] font-normal">
                          {column.name}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/60 bg-white">
                  {data.rows.map((row) => (
                    <tr
                      key={rowKey(row)}
                      className={
                        selectedKey === rowKey(row)
                          ? "bg-surface"
                          : "hover:bg-surface/60"
                      }
                    >
                      <td className="px-5 py-3">
                        <button
                          type="button"
                          className="text-ink underline underline-offset-4 disabled:cursor-wait disabled:text-muted"
                          aria-label={`查看 ${rowKey(row)} 的详情`}
                          disabled={query.isPlaceholderData}
                          onClick={(event) => {
                            detailTrigger.current = event.currentTarget;
                            selectKey(rowKey(row));
                          }}
                        >
                          查看
                        </button>
                      </td>
                      {table?.columns.map((column) => (
                        <td
                          key={column.key}
                          className="max-w-72 truncate px-4 py-3"
                          title={displayCell(column.key, row[column.key])}
                        >
                          {displayCell(column.key, row[column.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {data && (data.rows.length > 0 || displayedInput.page > 0) ? (
          <div className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs text-muted">
            <span>
              第 {displayedInput.page + 1} 页 · 每页 25 条
              {table ? ` · 全表 ${table.count.toLocaleString()} 条` : ""}
            </span>
            <div className="flex gap-2">
              <Button
                size="small"
                disabled={!input.page || query.isFetching}
                onClick={() => {
                  setInput({ ...input, page: input.page - 1 });
                  selectKey(null);
                }}
              >
                上一页
              </Button>
              <Button
                size="small"
                disabled={
                  !data?.has_more || query.isFetching || input.page >= 10000
                }
                onClick={() => {
                  setInput({ ...input, page: input.page + 1 });
                  selectKey(null);
                }}
              >
                下一页
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      {selected ? (
        <section
          aria-label="记录详情"
          className="mt-5 rounded-2xl bg-surface p-5"
        >
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">记录详情</h3>
            <Button
              variant="ghost"
              size="small"
              aria-label="关闭详情"
              icon={<X size={16} />}
              onClick={() => {
                selectKey(null);
                if (detailTrigger.current?.isConnected)
                  detailTrigger.current.focus();
                else searchInput.current?.focus();
              }}
            />
          </div>
          <div className="my-4 flex flex-wrap gap-2">
            {input.table === "household_subjects" &&
            typeof selected.id === "string" &&
            (selected.kind === "person" || selected.kind === "pet") ? (
              <Button
                size="small"
                onClick={() => {
                  const entity = contextBrowseQuerySchema.shape.entity.parse({
                    type: selected.kind,
                    id: selected.id,
                  });
                  navigate({ table: "context_records", entity });
                }}
              >
                查看相关上下文
              </Button>
            ) : null}
            {input.table === "context_records" &&
            typeof selected.id === "string" ? (
              <Button
                size="small"
                onClick={() =>
                  navigate({
                    table: "context_entities",
                    context_id: selectedId,
                  })
                }
              >
                查看关联对象
              </Button>
            ) : null}
            {input.table === "context_entities" &&
            typeof selected.contextId === "string" ? (
              <Button
                size="small"
                onClick={() =>
                  navigate({
                    table: "context_records",
                    context_id: selectedContextId,
                  })
                }
              >
                查看上下文正文
              </Button>
            ) : null}
          </div>
          <pre className="max-h-96 overflow-auto rounded-xl bg-surface p-4 font-mono text-xs leading-6 whitespace-pre-wrap break-all">
            {JSON.stringify(selected, null, 2)}
          </pre>
        </section>
      ) : null}
    </div>
  );
}

export default function DataPage() {
  const snapshot = useAtomValue(householdSnapshotAtom);
  const synced = useAtomValue(householdSyncedAtom);
  return (
    <HouseholdAccess fallback={<Notice>正在读取家庭状态…</Notice>}>
      {snapshot &&
      synced &&
      snapshot.projection.household.household.status === "running" ? (
        <DataBrowser key={snapshot.scope_epoch} scope={snapshot.scope_epoch} />
      ) : (
        <Notice>家庭连接就绪后可查看数据。</Notice>
      )}
    </HouseholdAccess>
  );
}
