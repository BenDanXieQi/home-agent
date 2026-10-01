import { useState } from "react";
import { useAtomValue } from "jotai";
import { useQuery } from "@tanstack/react-query";
import {
  Database,
  ArrowRight,
  RefreshCw,
  Search,
  KeyRound,
  Link2,
  X,
} from "lucide-react";
import { contextBrowseQuerySchema } from "@home-agent/api/household-context";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
} from "../../modules/household/state";
import { HouseholdAccess } from "../../modules/household/HouseholdAccess";
import { contextBrowseOptions } from "../../modules/household-context/queries";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
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
  const [selectedKey, selectKey] = useState<string | null>(null);
  const query = useQuery(contextBrowseOptions(input));
  const data = query.data;
  const table = data?.tables.find((item) => item.name === input.table);
  const selected = query.isError
    ? undefined
    : data?.rows.find((row) => rowKey(row) === selectedKey);
  const selectedId = typeof selected?.id === "string" ? selected.id : undefined;
  const selectedContextId =
    typeof selected?.contextId === "string" ? selected.contextId : undefined;
  const presentation = tablePresentation[input.table];
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
    <div className="space-y-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            家庭数据浏览器
          </h2>
          <p className="mt-2 text-sm text-muted">
            查看成员、上下文和它们之间的关联。当前页面只读。
          </p>
        </div>
        <Button
          icon={<RefreshCw size={15} />}
          status={query.isFetching ? "pending" : "idle"}
          onClick={() => {
            query.refetch().catch(() => {
              console.warn("Context browser refresh failed");
            });
          }}
        >
          刷新数据
        </Button>
      </div>

      <section
        aria-label="数据库表关系"
        className="rounded-2xl border border-line bg-white p-5"
      >
        <div className="mb-4 flex items-center gap-2 text-sm font-medium">
          <Database size={16} /> 三张表，一份上下文
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
          {(
            [
              "household_subjects",
              "context_entities",
              "context_records",
            ] as const
          ).map((name, index) => (
            <div key={name} className="contents">
              {index > 0 ? (
                <ArrowRight
                  aria-hidden
                  className="self-center justify-self-center text-muted max-md:rotate-90"
                  size={18}
                />
              ) : null}
              <button
                type="button"
                aria-pressed={input.table === name}
                onClick={() => navigate({ table: name })}
                className="min-w-0 rounded-xl border border-line p-4 text-left transition-colors hover:bg-surface aria-pressed:border-sage aria-pressed:bg-sage/5 focus-visible:outline-2 focus-visible:outline-sage"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {tablePresentation[name].title}
                  </span>
                  <span className="font-mono text-xl tabular-nums">
                    {data?.tables
                      .find((item) => item.name === name)
                      ?.count.toLocaleString() ?? "—"}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-[11px] text-muted">
                  {name}
                </p>
                <p className="mt-4 text-xs">
                  {tablePresentation[name].description}
                </p>
                <p className="mt-2 text-xs text-muted">
                  {tablePresentation[name].relation}
                </p>
              </button>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs leading-6 text-muted">
          例如“爸爸妈妈一起回家”：一条上下文 + 两条人物关联。关联只保存
          ID，不复制上下文正文。房间和设备沿用设备清单中的 ID。
        </p>
      </section>

      <section
        aria-label={presentation.title}
        className="overflow-hidden rounded-2xl border border-line bg-white"
      >
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line p-5">
          <div>
            <h3 className="font-semibold">{presentation.title}</h3>
            <p className="mt-1 font-mono text-xs text-muted">{input.table}</p>
          </div>
          <form
            className="flex min-w-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              searchRecords();
            }}
          >
            <label className="flex min-w-0 items-center gap-2 rounded-lg border border-line px-3">
              <Search size={15} className="shrink-0 text-muted" />
              <span className="sr-only">
                {input.table === "household_subjects"
                  ? "搜索名称"
                  : input.table === "context_records"
                    ? "搜索描述或主题"
                    : "搜索对象 ID"}
              </span>
              <input
                className="w-full max-w-60 bg-transparent py-2 text-sm outline-none"
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
            <Button type="button" size="small" onClick={searchRecords}>
              搜索
            </Button>
          </form>
        </div>
        {input.context_id || input.entity ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sage/5 px-5 py-3 text-xs">
            <Link2 size={14} />
            <span className="break-all">
              筛选：
              {input.context_id
                ? `上下文 ${input.context_id}`
                : `${input.entity?.type} · ${input.entity?.id}`}
            </span>
            <Button
              size="small"
              variant="ghost"
              onClick={() => navigate({ table: input.table })}
            >
              清除关联筛选
            </Button>
          </div>
        ) : null}
        {query.isError ? (
          <div className="p-5">
            <Notice tone="error">
              读取失败，请检查后端和数据库连接，并确认已执行数据库迁移。
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
          <output className="block p-12 text-center text-sm text-muted">
            正在读取数据库…
          </output>
        ) : !data?.rows.length ? (
          <div className="px-6 py-14 text-center">
            <Database className="mx-auto mb-4 text-muted" size={28} />
            <p className="font-medium">
              {input.search || input.context_id || input.entity
                ? "没有匹配的记录"
                : "这张表还没有数据"}
            </p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
              {input.search || input.context_id || input.entity
                ? "试试其他关键词，或清除筛选条件。"
                : "表结构已建立。上下文自动写入尚未接入，现有房间分析不会自动出现在这里。"}
            </p>
            {input.search ? (
              <Button
                className="mt-4"
                size="small"
                onClick={() => navigate({ table: input.table })}
              >
                清除搜索
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-left text-sm">
              <caption className="sr-only">
                {presentation.title}，第 {input.page + 1} 页
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
              <tbody className="divide-y divide-line">
                {data.rows.map((row) => (
                  <tr
                    key={rowKey(row)}
                    className={
                      selectedKey === rowKey(row)
                        ? "bg-sage/5"
                        : "hover:bg-surface/60"
                    }
                  >
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        className="text-sage underline underline-offset-4"
                        aria-label={`查看 ${rowKey(row)} 的详情`}
                        onClick={() => selectKey(rowKey(row))}
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
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-xs text-muted">
          <span>
            第 {input.page + 1} 页 · 每页 25 条
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
      </section>

      {selected ? (
        <section
          aria-label="记录详情"
          className="rounded-2xl border border-sage/30 bg-white p-5"
        >
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">记录详情</h3>
            <Button
              variant="ghost"
              size="small"
              aria-label="关闭详情"
              icon={<X size={16} />}
              onClick={() => selectKey(null)}
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

      <details
        className="rounded-2xl border border-line bg-white p-5"
        open={!data?.rows.length}
      >
        <summary className="cursor-pointer text-sm font-medium">
          字段说明 · {presentation.title}
        </summary>
        <p className="mt-2 text-xs text-muted">
          钥匙表示主键，用来唯一标识一条记录。字段结构来自后端表定义。
        </p>
        {table ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {table.columns.map((column) => (
              <div key={column.key} className="rounded-lg bg-surface p-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  {column.primary ? (
                    <KeyRound size={12} className="text-sage" />
                  ) : null}
                  {fieldLabels[column.key] ?? column.name}
                </div>
                <p className="mt-2 break-all font-mono text-[11px] text-muted">
                  {column.name} · {column.type}
                </p>
                <p className="mt-1 text-[11px] text-muted">
                  {column.nullable ? "允许为空" : "必填"}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted">读取成功后显示字段结构。</p>
        )}
      </details>
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
