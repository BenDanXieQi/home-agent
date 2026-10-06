import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flexRender, type Table as TableModel } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight } from "lucide-react";

/** Pages own data and table state; this component owns table presentation. */
export function Table<T>({
  table,
  label,
  rowLabel,
  onRowClick,
  onSort,
  renderDetails,
  disabled = false,
  empty,
}: {
  table: TableModel<T>;
  label: string;
  rowLabel: (row: T) => string;
  onRowClick?: (row: T) => void;
  onSort?: () => void;
  renderDetails?: (row: T) => ReactNode;
  disabled?: boolean;
  empty?: ReactNode;
}) {
  const id = useId();
  const scrollRegion = useRef<HTMLElement>(null);
  const tableElement = useRef<HTMLTableElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const region = scrollRegion.current;
    const element = tableElement.current;
    if (!region || !element) return undefined;
    const measure = () =>
      setOverflowing(
        region.clientWidth > 0 && region.scrollWidth > region.clientWidth,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const columns = table.getVisibleLeafColumns();
  const interactive = Boolean(onRowClick);
  // Keep absolutely positioned screen-reader labels inside the scroll boundary.
  // oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Native scroll regions need keyboard focus.
  return (
    <section
      ref={scrollRegion}
      aria-label={label}
      tabIndex={overflowing ? 0 : -1}
      className="relative min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-2xl bg-surface p-2 focus-visible:-outline-offset-2"
    >
      <table
        ref={tableElement}
        className="w-full table-fixed border-separate border-spacing-0 text-left text-[13px]"
        style={{ minWidth: columns.length * 140 + (interactive ? 40 : 0) }}
      >
        <caption className="sr-only">{label}</caption>
        <thead className="text-xs text-muted">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th
                  key={header.id}
                  scope="col"
                  colSpan={header.colSpan}
                  className="px-4 py-3 font-normal"
                  aria-sort={
                    header.column.getIsSorted() === "asc"
                      ? "ascending"
                      : header.column.getIsSorted() === "desc"
                        ? "descending"
                        : "none"
                  }
                >
                  {header.isPlaceholder ? null : header.column.getCanSort() ? (
                    <button
                      type="button"
                      className="flex items-center gap-2 text-left hover:text-ink focus-visible:outline-2"
                      onClick={() => {
                        header.column.toggleSorting();
                        onSort?.();
                      }}
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                      {header.column.getIsSorted() === "asc" ? (
                        <ArrowUp size={13} aria-hidden="true" />
                      ) : header.column.getIsSorted() === "desc" ? (
                        <ArrowDown size={13} aria-hidden="true" />
                      ) : (
                        <ArrowUpDown size={13} aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )
                  )}
                </th>
              ))}
              {interactive ? (
                <th scope="col" className="w-10">
                  <span className="sr-only">详情</span>
                </th>
              ) : null}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const open = row.getIsExpanded();
            const detailId = `${id}-${encodeURIComponent(row.id)}`;
            return (
              <Fragment key={row.id}>
                <tr
                  className={
                    interactive && !disabled
                      ? "cursor-pointer [&>td]:hover:bg-paper"
                      : ""
                  }
                  onClick={
                    interactive && !disabled
                      ? (event) => {
                          if (
                            event.target instanceof Element &&
                            event.target.closest(
                              "a, button:not([data-table-toggle]), input, select, textarea, [data-table-action]",
                            )
                          )
                            return;
                          onRowClick?.(row.original);
                        }
                      : undefined
                  }
                >
                  {row.getVisibleCells().map((cell, index) => (
                    <td
                      key={cell.id}
                      className={`max-w-80 bg-white bg-clip-padding px-4 py-4 align-middle wrap-anywhere ${open ? "" : "border-b-4 border-transparent"} ${index === 0 ? `font-medium ${open ? "rounded-tl-xl" : "rounded-l-xl"}` : "text-xs text-muted"} ${!interactive && index === columns.length - 1 ? "rounded-r-xl" : ""}`}
                    >
                      {index === 0 && interactive ? (
                        <button
                          type="button"
                          data-table-toggle
                          disabled={disabled}
                          aria-label={`${open ? "收起" : "展开"}${rowLabel(row.original)}详情`}
                          aria-expanded={open}
                          aria-controls={renderDetails ? detailId : undefined}
                          className="min-h-10 w-full text-left focus-visible:outline-2 disabled:cursor-wait"
                        >
                          <span className="line-clamp-2">
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )}
                          </span>
                        </button>
                      ) : (
                        <div
                          className="line-clamp-2"
                          title={
                            typeof cell.getValue() === "string"
                              ? String(cell.getValue())
                              : undefined
                          }
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </div>
                      )}
                    </td>
                  ))}
                  {interactive ? (
                    <td
                      className={`bg-white bg-clip-padding px-3 text-muted ${open ? "" : "border-b-4 border-transparent"} ${open ? "rounded-tr-xl" : "rounded-r-xl"}`}
                    >
                      <ChevronRight
                        size={15}
                        aria-hidden="true"
                        className={open ? "rotate-90" : ""}
                      />
                    </td>
                  ) : null}
                </tr>
                {open && renderDetails ? (
                  <tr>
                    <td
                      aria-label={`${rowLabel(row.original)}详情`}
                      colSpan={columns.length + (interactive ? 1 : 0)}
                      className="rounded-b-xl border-b-4 border-transparent bg-white bg-clip-padding px-5 pb-5"
                    >
                      <div id={detailId} className="pt-2">
                        <div className="max-w-5xl space-y-4">
                          {renderDetails(row.original)}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
          {!table.getRowModel().rows.length ? (
            <tr>
              <td
                colSpan={columns.length + (interactive ? 1 : 0)}
                className="px-5 py-12 text-center text-sm text-muted"
              >
                {empty ?? "暂无记录"}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
  // oxlint-enable jsx-a11y/no-noninteractive-tabindex
}
