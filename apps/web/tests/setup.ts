import { afterEach, beforeEach, vi } from "vitest";
import { fetchMock } from "./support/http";

// Install before application imports: the RPC client captures fetch at construction.
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(
    new Error("Unexpected HTTP request: configure the test transport"),
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
