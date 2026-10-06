import { lazy, memo, Suspense, useState } from "react";
const VirtualJson = lazy(() =>
  import("./VirtualJson").then((module) => ({ default: module.VirtualJson })),
);

/** Pages own the data lifetime; this component only owns disclosure state. */
export const JsonData = memo(function JsonData({
  value,
  label = "完整原始字段 JSON",
  name = "data",
  defaultOpen = false,
}: {
  value: unknown;
  label?: string;
  name?: string;
  defaultOpen?: boolean;
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
          <Suspense
            fallback={
              <output className="text-xs text-muted">正在读取 JSON…</output>
            }
          >
            <VirtualJson value={value} name={name} />
          </Suspense>
        </div>
      ) : null}
    </details>
  );
});
