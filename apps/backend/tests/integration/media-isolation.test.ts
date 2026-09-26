import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { runningHousehold } from "../support/household-harness";
import { eventually } from "../support/async";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
afterEach(async () => {
  for (const household of households.splice(0)) await household.close();
  mock.restore();
});

test("an unconfirmed initial media installation preserves cloud access and is deleted before its replacement", async () => {
  // MiLoCo test_reinit.py::test_client_init_camera_failure_triggers_full_cleanup
  // tears down its combined native client. Here media owns a separate remote lease.
  const originalFetch = globalThis.fetch;
  let loseFirstInstallResponse = true;
  const request = async (
    input: Parameters<typeof originalFetch>[0],
    init?: Parameters<typeof originalFetch>[1],
  ) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const response = await originalFetch(input, init);
    if (
      loseFirstInstallResponse &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/api/home-agent/mijia/session" &&
      init?.method === "PUT"
    ) {
      loseFirstInstallResponse = false;
      // The peer received the authorization; the backend never receives its ACK.
      await response.body?.cancel();
      throw new TypeError("fixture lost installation response");
    }
    return response;
  };
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(request, { preconnect: originalFetch.preconnect }),
  );

  const household = await runningHousehold();
  households.push(household);
  const initial = household.peer.calls.filter(
    (call) => call.path === "session" && call.method === "PUT",
  );
  expect(initial).toHaveLength(1);
  const failedSessionId = initial[0]!.body.sessionId;
  expect(failedSessionId).toBeString();
  expect(household.service.snapshot().binding).toMatchObject({
    status: "error",
    error: { code: "mijia_go2rtc_unavailable" },
  });
  expect(household.service.identity()).toBe('["cn","100001"]');
  expect(household.service.snapshot().account.status).toBe("authenticated");
  expect(household.runtime.ready).toBe(true);
  expect(
    await household.service.readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).toMatchObject([{ status: "success", value: 21 }]);

  household.service.requestConnection();
  await eventually(
    () =>
      household.service.snapshot().connectionOperation?.status !== "running",
  );
  expect(household.service.snapshot().connectionOperation?.status).toBe(
    "succeeded",
  );
  expect(household.service.snapshot().binding.status).toBe("ready");
  const lifecycle = household.peer.calls.filter(
    (call) => call.path === "session" && !call.body.reset,
  );
  expect(lifecycle.map((call) => call.method)).toEqual([
    "PUT",
    "DELETE",
    "PUT",
  ]);
  expect(lifecycle[1]!.body.sessionId).toBe(failedSessionId);
  expect(lifecycle[2]!.body.sessionId).not.toBe(failedSessionId);
  expect(household.service.identity()).toBe('["cn","100001"]');
});
