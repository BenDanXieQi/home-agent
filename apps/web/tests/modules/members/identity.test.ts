import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractRecording,
  uploadReference,
} from "../../../src/modules/members/identity";
import { prepareAnalysisImage } from "../../../src/modules/perception/image-analysis";
import { epoch } from "../../support/household";
import { fetchMock, requestAt, untilAborted } from "../../support/http";

vi.mock("../../../src/modules/perception/image-analysis", () => ({
  prepareAnalysisImage: vi.fn(),
}));

const member = {
  memberId: "4bf80fbb-083c-4a1d-b0b7-49f8f2a8caa4",
  scope_epoch: epoch,
};

const sources = [
  {
    name: "Photo upload",
    path: "upload",
    start: (signal: AbortSignal) =>
      uploadReference(
        member,
        [new File(["photo"], "portrait.png", { type: "image/png" })],
        signal,
      ),
  },
  {
    name: "Recording extraction",
    path: "recording",
    start: (signal: AbortSignal) =>
      extractRecording(
        {
          ...member,
          deviceId: "camera-1",
          channel: 1,
          recordedAt: "2026-10-21T00:00:00.000Z",
        },
        new Blob(["recording"], { type: "video/webm" }),
        signal,
      ),
  },
];

beforeEach(() => {
  vi.mocked(prepareAnalysisImage).mockResolvedValue({
    name: "portrait.png",
    blob: new Blob(["prepared photo"], { type: "image/png" }),
    url: "blob:prepared-photo",
    width: 10,
    height: 20,
  });
});

describe.each(sources)("$name session cleanup", ({ path, start }) => {
  it("cancels the submitted session after a lost response and waits for cleanup", async () => {
    const cleanup = Promise.withResolvers<Response>();
    fetchMock
      .mockRejectedValueOnce(new TypeError("extraction response lost"))
      .mockReturnValueOnce(cleanup.promise);
    let settled = false;
    const pending = start(new AbortController().signal);
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const assertion = expect(pending).rejects.toMatchObject({
      details: { code: "network_error" },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const settledBeforeCleanup = settled;
    cleanup.resolve(Response.json({ cancelled: true }));
    await assertion;

    const extraction = requestAt(0);
    const sessionId = extraction.url.searchParams.get("sessionId");
    expect(extraction.url.pathname).toBe(
      `/api/household-members/references/${path}`,
    );
    expect(sessionId).toBeTruthy();
    expect(requestAt(1).body).toEqual({ ...member, sessionId });
    expect(requestAt(1).keepalive).toBe(true);
    expect(requestAt(1).url.pathname).toBe(
      "/api/household-members/references/cancel",
    );
    expect(settledBeforeCleanup).toBe(false);
    expect(settled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses an independent cleanup request after the extraction is aborted", async () => {
    fetchMock
      .mockImplementationOnce((_input, init) => untilAborted(init?.signal))
      .mockResolvedValueOnce(Response.json({ cancelled: true }));
    const controller = new AbortController();
    const pending = start(controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({
      details: { code: "request_cancelled" },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestAt(1).body).toEqual({
      ...member,
      sessionId: requestAt(0).url.searchParams.get("sessionId"),
    });
    expect(requestAt(0).signal?.aborted).toBe(true);
    expect(requestAt(1).signal?.aborted).toBe(false);
  });

  it("propagates a cleanup failure instead of reporting only the lost response", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("extraction response lost"))
      .mockResolvedValueOnce(
        Response.json(
          { code: "perception_busy", message: "Cleanup could not complete" },
          { status: 503 },
        ),
      );

    await expect(start(new AbortController().signal)).rejects.toMatchObject({
      details: { code: "perception_busy" },
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
