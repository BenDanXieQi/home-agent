import { Table } from "../../components/Table";
import { SearchField } from "../../components/SearchField";
import { useMemo, useState, type ReactNode } from "react";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  useReactTable,
  type ColumnDef,
  type CellContext,
  type SortingState,
} from "@tanstack/react-table";
import { Select } from "../../components/Select";
import { SearchSelect } from "../../components/SearchSelect";
import { Button } from "../../components/Button";
import { JsonData } from "../../components/json/JsonData";

function fieldText(value: unknown) {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return String(value);
  return JSON.stringify(value) ?? "—";
}

function DefaultCell({
  getValue,
}: Pick<CellContext<unknown, unknown>, "getValue">) {
  return fieldText(getValue());
}

const defaultColumn = { cell: DefaultCell };
const searchColumnId = "record_search";
const noFilters: string[] = [];
const noSorting: SortingState = [];

export function RecordBrowser<T>({
  rows,
  identify,
  title,
  describe,
  render,
  rawValue,
  toolbar,
  columns: suppliedColumns,
  filterColumns = noFilters,
  label = "数据记录",
  initialSorting = noSorting,
}: {
  toolbar?: ReactNode;
  rows: T[];
  identify: (row: T) => string;
  title: (row: T) => string;
  describe: (row: T) => string;
  render?: (row: T) => ReactNode;
  rawValue?: (row: T) => unknown;
  columns?: ColumnDef<T>[];
  filterColumns?: string[];
  label?: string;
  initialSorting?: SortingState;
}) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const columns = useMemo<ColumnDef<T>[]>(
    () => [
      ...(suppliedColumns ?? [
        { id: "name", header: "名称 / 标识", accessorFn: title },
        { id: "summary", header: "摘要", accessorFn: describe },
      ]),
      {
        id: searchColumnId,
        accessorFn: (row) => `${identify(row)} ${title(row)} ${describe(row)}`,
        enableSorting: false,
        enableColumnFilter: false,
      },
    ],
    [suppliedColumns, identify, title, describe],
  );
  // oxlint-disable-next-line react/incompatible-library -- TanStack Table owns mutable table state; this component is not compiler-memoized.
  const table = useReactTable({
    data: rows,
    columns,
    defaultColumn,
    getRowId: identify,
    getRowCanExpand: () => true,
    state: { globalFilter: search.trim(), expanded },
    onGlobalFilterChange: setSearch,
    initialState: {
      pagination: { pageSize: 25 },
      sorting: initialSorting,
      columnVisibility: { [searchColumnId]: false },
    },
    globalFilterFn: "includesString",
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });
  const total = table.getFilteredRowModel().rows.length;
  const { pageIndex, pageSize } = table.getState().pagination;
  function collapseDetails() {
    setExpanded({});
  }
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          {toolbar}
          <span aria-live="polite">
            {total === rows.length
              ? `${total} 条记录`
              : `匹配 ${total} / ${rows.length} 条`}
          </span>
        </div>
        <SearchField
          label={`搜索${label}`}
          placeholder="搜索名称、标识或字段值"
          value={search}
          className="w-full sm:w-72"
          onChange={(value) => {
            table.setGlobalFilter(value);
            table.setPageIndex(0);
            collapseDetails();
          }}
        />
        {!filterColumns.length && search ? (
          <Button
            size="small"
            onClick={() => {
              table.setGlobalFilter("");
              table.setPageIndex(0);
              collapseDetails();
            }}
          >
            清除搜索
          </Button>
        ) : null}
      </div>
      {filterColumns.length ? (
        <div className="flex flex-wrap items-center gap-3">
          {filterColumns.map((id) => {
            const column = table.getColumn(id);
            if (!column) return null;
            const selectedFilter = column.getFilterValue();
            const selectedValue =
              typeof selectedFilter === "string" ? selectedFilter : "";
            const options = Array.from(
              column.getFacetedUniqueValues().entries(),
            )
              .filter(
                (entry): entry is [string, number] =>
                  typeof entry[0] === "string",
              )
              .toSorted(([a], [b]) => a.localeCompare(b, "zh-CN"));
            if (
              selectedValue &&
              !options.some(([value]) => value === selectedValue)
            )
              options.push([selectedValue, 0]);
            return (
              <div
                key={id}
                className="flex w-full min-w-0 flex-col gap-1.5 text-xs text-muted sm:w-48"
              >
                <span className="shrink-0">
                  {String(column.columnDef.header)}
                </span>
                <SearchSelect
                  label={`筛选${String(column.columnDef.header)}`}
                  className="border-line bg-paper"
                  value={selectedValue}
                  options={[
                    { value: "", label: "全部" },
                    ...options.map(([value, count]) => ({
                      value,
                      label: `${value} · ${count}`,
                    })),
                  ]}
                  onValueChange={(value) => {
                    column.setFilterValue(value || undefined);
                    table.setPageIndex(0);
                    collapseDetails();
                  }}
                />
              </div>
            );
          })}
          {table.getState().columnFilters.length || search ? (
            <Button
              size="small"
              onClick={() => {
                table.resetColumnFilters();
                table.setGlobalFilter("");
                table.setPageIndex(0);
                collapseDetails();
              }}
            >
              清除筛选
            </Button>
          ) : null}
        </div>
      ) : null}
      <Table
        table={table}
        label={label}
        rowLabel={title}
        onRowClick={(record) => {
          const id = identify(record);
          setExpanded(expanded[id] ? {} : { [id]: true });
        }}
        onSort={() => {
          table.setPageIndex(0);
          collapseDetails();
        }}
        renderDetails={(record) => (
          <>
            {render?.(record)}
            <JsonData value={rawValue ? rawValue(record) : record} />
          </>
        )}
        empty={
          rows.length ? "没有匹配记录，试试其他筛选条件。" : "这部分尚无记录。"
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <label className="m-0 flex items-center gap-2 whitespace-nowrap">
          <span className="shrink-0">每页</span>
          <Select
            label="每页记录数"
            value={String(pageSize)}
            className="w-24 border-line bg-paper"
            options={[25, 50, 100].map((size) => ({
              value: String(size),
              label: `${size} 条`,
            }))}
            onValueChange={(value) => {
              table.setPageSize(Number(value));
              table.setPageIndex(0);
              collapseDetails();
            }}
          />
          <span>
            {total
              ? `${pageIndex * pageSize + 1}–${Math.min((pageIndex + 1) * pageSize, total)} / ${total}`
              : "0 条"}
          </span>
        </label>
        <div className="flex items-center gap-2">
          <Button
            size="small"
            disabled={!table.getCanPreviousPage()}
            onClick={() => {
              table.firstPage();
              collapseDetails();
            }}
          >
            首页
          </Button>
          <Button
            size="small"
            disabled={!table.getCanPreviousPage()}
            onClick={() => {
              table.previousPage();
              collapseDetails();
            }}
          >
            上一页
          </Button>
          <span>
            {pageIndex + 1} / {Math.max(1, table.getPageCount())}
          </span>
          <Button
            size="small"
            disabled={!table.getCanNextPage()}
            onClick={() => {
              table.nextPage();
              collapseDetails();
            }}
          >
            下一页
          </Button>
          <Button
            size="small"
            disabled={!table.getCanNextPage()}
            onClick={() => {
              table.lastPage();
              collapseDetails();
            }}
          >
            末页
          </Button>
        </div>
      </div>
    </div>
  );
}
