import { expect, test } from "bun:test";
import { AppError } from "@home-agent/api/errors";
import { createRecordingsRoutes } from "../../src/recordings/routes";
import { RecordingCoverageError } from "../../src/recordings/selection";

function failedRead(error: Error) {
  const app = createRecordingsRoutes(
    {
      async ranges() {
        return [];
      },
      async readMedia() {
        throw error;
      },
    },
    4000,
  );

  return app.request(
    "http://localhost:4000/media",
    {
      method: "POST",
      headers: {
        host: "localhost:4000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: "12345",
        channel: 1,
        selection: { kind: "range", start: 1_000_000, end: 1_128_000 },
        output: { kind: "video", codec: "h264" },
      }),
    },
    {
      requestIP: () => ({ address: "127.0.0.1", port: 50000, family: "IPv4" }),
    },
  );
}

test("incomplete recording coverage is distinct from expired window media", async () => {
  const response = await failedRead(
    new RecordingCoverageError("Recording selection has missing segments"),
  );

  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    code: "recording_coverage_unavailable",
  });
});

test("expired media retains its own unavailable response", async () => {
  const response = await failedRead(
    new AppError("perception_media_unavailable"),
  );

  expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({
    code: "perception_media_unavailable",
  });
});
