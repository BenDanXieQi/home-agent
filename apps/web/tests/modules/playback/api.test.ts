import { describe, expect, it, vi } from "vitest";
import {
  offerMijiaPlayback,
  releaseMijiaPlayback,
  reserveMijiaPlayback,
} from "../../../src/modules/playback/api";
import { epoch, mediaRevision, playbackId } from "../../support/household";
import {
  fetchMock,
  requestAt,
  untilAborted,
  useRequestClock,
} from "../../support/http";

describe("viewer reservation and idempotent signaling", () => {
  it("reserves the explicitly supplied household, revision and lens", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: playbackId }));
    expect(
      await reserveMijiaPlayback({
        scope_epoch: epoch,
        revision: mediaRevision,
        deviceId: "camera-1",
        channel: 2,
      }),
    ).toEqual({ id: playbackId });
    expect(requestAt(0)).toMatchObject({
      method: "POST",
      body: {
        scope_epoch: epoch,
        revision: mediaRevision,
        deviceId: "camera-1",
        channel: 2,
      },
    });
    expect(requestAt(0).url.pathname).toBe("/api/mijia/playback/reservations");
  });

  it("retries a lost signaling response once with the same viewer, revision and original SDP", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("connection closed"));
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: playbackId,
        sdp: "answer",
        connection: {
          sourceRecentlyActive: true,
          timings: { prepareMs: 10, negotiationMs: 20 },
        },
      }),
    );
    const offer = { revision: mediaRevision, sdp: "original-offer-sdp" };
    const pending = offerMijiaPlayback(
      playbackId,
      offer,
      new AbortController().signal,
    );
    offer.sdp = "mutated-after-call";
    await expect(pending).resolves.toEqual({
      id: playbackId,
      sdp: "answer",
      connection: {
        sourceRecentlyActive: true,
        timings: { prepareMs: 10, negotiationMs: 20 },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const index of [0, 1]) {
      expect(requestAt(index)).toMatchObject({
        method: "PUT",
        body: { revision: mediaRevision, sdp: "original-offer-sdp" },
      });
      expect(requestAt(index).url.pathname).toBe(
        `/api/mijia/playback/${playbackId}`,
      );
    }
  });

  it("stops after the second transport failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(
      offerMijiaPlayback(
        playbackId,
        { revision: mediaRevision, sdp: "offer" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ details: { code: "network_error" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 70-second signaling timeout once with a new per-attempt deadline", async () => {
    useRequestClock();
    fetchMock.mockImplementationOnce((_input, init) =>
      untilAborted(init?.signal),
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: playbackId,
        sdp: "answer",
        connection: {
          sourceRecentlyActive: true,
          timings: { prepareMs: 10, negotiationMs: 20 },
        },
      }),
    );
    const pending = offerMijiaPlayback(
      playbackId,
      { revision: mediaRevision, sdp: "offer" },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(69_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      id: playbackId,
      sdp: "answer",
      connection: {
        sourceRecentlyActive: true,
        timings: { prepareMs: 10, negotiationMs: 20 },
      },
    });
    expect(requestAt(0).signal?.aborted).toBe(true);
    expect(requestAt(1).signal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      response: () =>
        Response.json(
          { code: "mijia_stale_session", message: "Scope changed" },
          { status: 409 },
        ),
      code: "mijia_stale_session",
    },
    {
      response: () => Response.json({ id: "not-a-uuid", sdp: "answer" }),
      code: "invalid_response",
    },
  ])("does not replay signaling after $code", async ({ response, code }) => {
    fetchMock.mockResolvedValueOnce(response());
    await expect(
      offerMijiaPlayback(
        playbackId,
        { revision: mediaRevision, sdp: "offer" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ details: { code } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry after the viewer's parent scope has cancelled", async () => {
    const parent = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      parent.abort();
      throw new TypeError("connection lost during teardown");
    });
    await expect(
      offerMijiaPlayback(
        playbackId,
        { revision: mediaRevision, sdp: "offer" },
        parent.signal,
      ),
    ).rejects.toMatchObject({ details: { code: "request_cancelled" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases the viewer with keepalive without requiring household state", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline during navigation"));
    releaseMijiaPlayback(playbackId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requestAt(0)).toMatchObject({
      method: "DELETE",
      keepalive: true,
      body: null,
    });
    expect(requestAt(0).url.pathname).toBe(`/api/mijia/playback/${playbackId}`);
  });
});
