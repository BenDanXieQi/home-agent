import { useMemo, type ReactNode } from "react";
import { RecordBrowser } from "./RecordBrowser";
import { identified } from "./presentation";

export function ObjectRecords({
  value,
  toolbar,
}: {
  value: Record<string, unknown>;
  toolbar?: ReactNode;
}) {
  const rows = useMemo(
    () => Object.entries(value).map(([id, data]) => ({ id, data })),
    [value],
  );
  return (
    <RecordBrowser
      toolbar={toolbar}
      rows={rows}
      identify={identified}
      rawValue={(row) => row.data}
      title={identified}
      describe={(row) =>
        typeof row.data === "object" && row.data !== null
          ? Object.entries(row.data)
              .filter(
                ([, field]) => field === null || typeof field !== "object",
              )
              .map(([key, field]) => `${key}: ${String(field)}`)
              .join(" · ")
          : String(row.data)
      }
    />
  );
}
