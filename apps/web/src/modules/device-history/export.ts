import { AppError, errorPayload } from "@home-agent/api/errors";
import { deviceHistoryPolicy } from "@home-agent/api/device-history";
import { streamDeviceHistory } from "./stream";
import type { HistoryQuery } from "./page";
import { RequestError } from "../../api/errors";

export async function exportDeviceHistory(
  input: HistoryQuery,
  signal: AbortSignal,
  progress: (count: number) => void,
) {
  const encoder = new TextEncoder();
  const parts: ReturnType<typeof encoder.encode>[] = [];
  let bytes = 0;
  let count = 0;
  await streamDeviceHistory(
    {
      ...input,
      limit: deviceHistoryPolicy.maxLimit,
      cursor: undefined,
    },
    "export",
    signal,
    (event) => {
      if (event.event !== "page") return;
      if (event.data.records.length) {
        const chunk = encoder.encode(
          `${event.data.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        );
        bytes += chunk.byteLength;
        if (bytes > deviceHistoryPolicy.exportBytes)
          throw new RequestError(
            errorPayload(new AppError("device_history_export_too_large")),
          );
        parts.push(chunk);
      }
      count += event.data.records.length;
      progress(count);
    },
  );
  signal.throwIfAborted();
  return new Blob(parts, { type: "application/x-ndjson" });
}
