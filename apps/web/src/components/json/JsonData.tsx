import { lazy, memo, Suspense, useState } from "react";
import { JsonLoading } from "./JsonReading";
const VirtualJson = lazy(() =>
  import("./VirtualJson").then((module) => ({ default: module.VirtualJson })),
);

/** Pages own the data lifetime; this component only owns disclosure state. */
export const JsonData = memo(function JsonData({
  value,
  label = "完整原始字段 JSON",
  name = "data",
  defaultOpen = false,
  loadingMessage,
  live = false,
}: {
  value: unknown;
  label?: string;
  name?: string;
  defaultOpen?: boolean;
  loadingMessage?: string | undefined;
  live?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer rounded py-2 text-xs text-muted focus-visible:outline-2">
        {label}
      </summary>
      {open ? (
        <div className="mt-2 space-y-3">
          {loadingMessage ? (
            <JsonLoading
              value={value}
              name={name}
              message={loadingMessage}
              awaitingValue
            />
          ) : (
            <Suspense
              fallback={
                <JsonLoading
                  value={value}
                  name={name}
                  message="正在读取 JSON…"
                />
              }
            >
              <VirtualJson value={value} name={name} live={live} />
            </Suspense>
          )}
        </div>
      ) : null}
    </details>
  );
});
