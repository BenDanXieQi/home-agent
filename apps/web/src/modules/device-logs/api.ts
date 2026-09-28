import { deviceLogSnapshotSchema } from "@home-agent/api/device-logs";
import { requestJson } from "../../api/client";

export function executeCaptureCommand(action: "start" | "stop") {
  return action === "start"
    ? requestJson(
        (client, options) =>
          client.api.mijia.logs.capture.$post(
            { json: { duration_seconds: 600 } },
            options,
          ),
        deviceLogSnapshotSchema,
      )
    : requestJson(
        (client, options) => client.api.mijia.logs.capture.$delete({}, options),
        deviceLogSnapshotSchema,
      );
}
