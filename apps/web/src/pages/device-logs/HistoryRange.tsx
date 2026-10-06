import { useId, useState } from "react";
import { Check, ChevronDown, Clock3 } from "lucide-react";
import { Popover } from "radix-ui";
import { Button } from "../../components/Button";
import type { HistoryQuery } from "../../modules/device-history/page";

import { historyRangePresets } from "./log-data";

function localInputTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function rangeTime(value: string) {
  const date = new Date(value);
  const today = new Date().toDateString() === date.toDateString();
  return `${today ? "" : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) + " "}${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

export function HistoryRange({
  range,
  live,
  ready,
  selected,
  onChange,
}: {
  range: Pick<HistoryQuery, "start" | "end">;
  live: boolean;
  ready: boolean;
  selected: (typeof historyRangePresets)[number]["duration"] | null;
  onChange: (
    range: Pick<HistoryQuery, "start" | "end">,
    live: boolean,
    selected: (typeof historyRangePresets)[number]["duration"] | null,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(selected === null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const errorId = useId();
  const label = `${rangeTime(range.start)} — ${live ? "至今" : rangeTime(range.end)}`;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          size="small"
          variant="ghost"
          icon={<Clock3 size={14} />}
          aria-label={`时间范围：${label}`}
          disabled={!ready}
          className="tabular-nums"
        >
          <span className="inline-flex items-center gap-1.5">
            {label}
            <ChevronDown size={12} className="text-muted" aria-hidden="true" />
          </span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-labelledby={titleId}
          className="z-60 w-80 max-w-[calc(100vw_-_24px)] rounded-xl bg-white p-4 shadow-panel outline-none"
        >
          <h2 id={titleId} className="mb-3 text-sm font-medium">
            时间范围
          </h2>
          <div className="grid grid-cols-2 gap-2">
            {historyRangePresets.map((preset) => (
              <Button
                key={preset.duration}
                size="small"
                className="w-full"
                variant={selected === preset.duration ? "primary" : "secondary"}
                aria-pressed={selected === preset.duration}
                icon={
                  selected === preset.duration ? <Check size={12} /> : undefined
                }
                disabled={!ready}
                onClick={() => {
                  const end = Date.now();
                  onChange(
                    {
                      start: new Date(end - preset.duration).toISOString(),
                      end: new Date(end).toISOString(),
                    },
                    true,
                    preset.duration,
                  );
                  setOpen(false);
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            从所选时间开始，持续显示新报告。
          </p>
          <button
            type="button"
            aria-expanded={custom}
            aria-pressed={selected === null}
            className="mt-3 flex w-full items-center justify-between border-t border-line pt-3 text-xs text-ink"
            onClick={() => setCustom(!custom)}
          >
            <span className="inline-flex items-center gap-1.5">
              自定义时间
              {selected === null ? (
                <Check size={12} aria-hidden="true" />
              ) : null}
            </span>
            <ChevronDown
              size={14}
              className={custom ? "rotate-180" : ""}
              aria-hidden="true"
            />
          </button>
          {custom ? (
            <form
              className="mt-3 grid gap-3 text-xs"
              aria-label="自定义历史时间范围"
              onSubmit={(event) => {
                event.preventDefault();
                if (!ready) return;
                const fields = new FormData(event.currentTarget);
                const startValue = fields.get("start");
                const endValue = fields.get("end");
                if (
                  typeof startValue !== "string" ||
                  typeof endValue !== "string"
                )
                  return;
                const start = new Date(startValue);
                const end = new Date(endValue);
                if (
                  !Number.isFinite(start.getTime()) ||
                  !Number.isFinite(end.getTime())
                ) {
                  setError("请输入有效的起止时间。");
                  return;
                }
                if (start >= end) {
                  setError("结束时间须晚于开始时间。");
                  return;
                }
                setError(null);
                onChange(
                  { start: start.toISOString(), end: end.toISOString() },
                  false,
                  null,
                );
                setOpen(false);
              }}
            >
              {(["start", "end"] as const).map((field) => (
                <label key={field} className="grid gap-1.5">
                  <span className="text-muted">
                    {field === "start" ? "从" : "到"}
                  </span>
                  <input
                    type="datetime-local"
                    name={field}
                    required
                    defaultValue={localInputTime(range[field])}
                    aria-describedby={error ? errorId : undefined}
                    className="min-h-9 w-full min-w-0 rounded-md border border-line bg-surface px-2.5 text-xs tabular-nums"
                  />
                </label>
              ))}
              {error ? (
                <p id={errorId} role="alert" className="text-danger">
                  {error}
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted">
                  本地时间 · 固定范围
                </span>
                <Button
                  type="submit"
                  variant="primary"
                  size="small"
                  disabled={!ready}
                >
                  应用
                </Button>
              </div>
            </form>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
