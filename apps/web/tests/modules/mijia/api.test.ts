import { describe, expect, it, vi } from "vitest";
import { executeMijiaCommand } from "../../../src/modules/mijia/api";
import { epoch, loginId } from "../../support/household";
import {
  fetchMock,
  requestAt,
  untilAborted,
  useRequestClock,
} from "../../support/http";

describe("Mijia command HTTP boundary", () => {
  it("allows human verification to run beyond control deadlines but stops at 120 seconds", async () => {
    useRequestClock();
    fetchMock.mockImplementationOnce((_input, init) =>
      untilAborted(init?.signal),
    );
    const pending = executeMijiaCommand(
      { type: "verifyLogin", loginId, ticket: "123456" },
      epoch,
      new AbortController().signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      details: { code: "request_timeout" },
    });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(requestAt(0).signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
