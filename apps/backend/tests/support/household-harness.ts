import { mock, spyOn } from "bun:test";
import { HouseholdRuntime } from "../../src/household/runtime";
import { MijiaService } from "../../src/mijia/service";
import { MiCloud } from "../../src/mijia/protocols/micloud";
import { MiotSpecClient } from "../../src/mijia/protocols/micloud/spec";
import { interceptMqtt } from "../mijia/observations/support";
import { mediaPeer } from "../mijia/media/support";
import { credentialStore, homeSelectionStore } from "./account-fixtures";
import { deferred, eventually } from "./async";
import {
  accountClient,
  preparedSpec,
  savedSession,
  specUrn,
} from "./protocol-fixtures";

export function householdCatalog() {
  return {
    homes: [
      {
        id: "home-a",
        name: "Home A",
        shared: false,
        deviceIds: ["device-a", "stable"],
        rooms: [],
      },
      {
        id: "home-b",
        name: "Home B",
        shared: true,
        deviceIds: ["device-b"],
        rooms: [],
      },
    ],
    devices: [
      {
        did: "device-a",
        model: "test.sensor.contract",
        spec_type: specUrn,
        home_id: "home-a",
        isOnline: false,
      },
      {
        did: "stable",
        model: "test.sensor.contract",
        spec_type: specUrn,
        home_id: "home-a",
        isOnline: true,
      },
      {
        did: "device-b",
        model: "test.sensor.contract",
        spec_type: specUrn,
        home_id: "home-b",
        isOnline: true,
      },
    ],
  } satisfies Awaited<ReturnType<MiCloud["getCatalog"]>>;
}

/** Real account, runtime, directory, specification and read owners; only I/O is replaced. */
export async function runningHousehold(
  initialCatalog: Awaited<
    ReturnType<MiCloud["getCatalog"]>
  > = householdCatalog(),
) {
  const mqtt = interceptMqtt();
  const peer = mediaPeer();
  const candidate = accountClient();
  const renewal = spyOn(MiCloud.prototype, "renewSession").mockResolvedValue(
    candidate,
  );
  const catalog = spyOn(MiCloud.prototype, "getCatalog").mockResolvedValue(
    initialCatalog,
  );
  const profile = spyOn(MiCloud.prototype, "getProfile").mockResolvedValue({
    name: "Test account",
    avatarUrl: null,
  });
  const properties = spyOn(
    MiCloud.prototype,
    "getProperties",
  ).mockImplementation((batch, _signal, onStarted) => {
    onStarted?.(new Date().toISOString());
    return Promise.resolve(batch.map((address) => ({ ...address, value: 21 })));
  });
  const resolve = spyOn(MiotSpecClient.prototype, "resolve").mockImplementation(
    (_device, signal) =>
      Promise.resolve({ urn: specUrn, requestSignal: signal }),
  );
  const { category, spec } = preparedSpec();
  const read = spyOn(MiotSpecClient.prototype, "read").mockResolvedValue({
    urn: specUrn,
    category,
    spec,
  });
  const store = credentialStore();
  const homes = homeSelectionStore({ homeId: "home-a" });
  const repository = {
    read: mock<
      NonNullable<ConstructorParameters<typeof HouseholdRuntime>[1]>["read"]
    >(() => Promise.resolve(undefined)),
    save: mock<
      NonNullable<ConstructorParameters<typeof HouseholdRuntime>[1]>["save"]
    >((_account, _home, _directory, assertCurrent) => {
      assertCurrent();
      return Promise.resolve(new Date().toISOString());
    }),
  };
  const service = new MijiaService({
    credentialStore: store,
    homeSelectionStore: homes,
    readGo2rtcUrl: () => Promise.resolve(peer.adapter.url),
  });
  const runtime = new HouseholdRuntime(service, repository);
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      try {
        await peer.close();
      } finally {
        mqtt.restore();
        for (const boundary of [
          renewal,
          catalog,
          profile,
          properties,
          resolve,
          read,
        ])
          boundary.mockRestore();
      }
    }
  };
  try {
    runtime.start();
    await service.initialize();
    await eventually(
      () =>
        runtime.ready &&
        Object.values(runtime.snapshot().projection.spec).some(
          (value) => value.status === "ready",
        ),
    );
    return {
      service,
      runtime,
      repository,
      store,
      homes,
      catalog,
      properties,
      renewal,
      acceptedAccount: candidate,
      mqtt,
      peer,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Hold the next durable credential write before its stored value changes. */
export function holdCredentialWrite(
  household: Awaited<ReturnType<typeof runningHousehold>>,
) {
  const implementation = household.store.write.getMockImplementation();
  if (!implementation)
    throw new Error("Expected a credential persistence implementation");
  const entered = deferred<Parameters<typeof household.store.write>>();
  const gate = deferred();
  const committed = deferred();
  household.store.write.mockImplementationOnce(async (...args) => {
    entered.resolve(args);
    await gate.promise;
    await implementation(...args);
    committed.resolve();
  });
  return {
    started: entered.promise,
    committed: committed.promise,
    release: () => gate.resolve(),
  };
}

function responseAt(url: URL, response: Response) {
  Object.defineProperty(response, "url", { value: url.href });
  return response;
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

/** Replay provider HTTP replies while keeping MiCloud QR/cookies and OAuth parsing real. */
export function loginHttp(
  household: Awaited<ReturnType<typeof runningHousehold>>,
  overrides: Parameters<typeof savedSession>[0] = { userId: "200002" },
) {
  const session = savedSession(overrides);
  const originalFetch = globalThis.fetch;
  const mediaOrigin = new URL(household.peer.adapter.url).origin;
  const calls: { url: string; method: string }[] = [];
  let authorization: URL | undefined;
  const implementation = Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.origin === mediaOrigin) return originalFetch(input, init);
      calls.push({ url: url.href, method: init?.method ?? "GET" });
      let response: Response;
      if (url.origin === "https://account.xiaomi.com") {
        switch (url.pathname) {
          case "/longPolling/loginUrl":
            response = Response.json({
              qr: "https://account.xiaomi.com/fixture/qr",
              lp: "https://account.xiaomi.com/fixture/poll",
              timeout: 60,
              timeInterval: 2,
            });
            break;
          case "/fixture/qr":
            response = new Response(Buffer.from("fixture-png"), {
              headers: { "content-type": "image/png" },
            });
            break;
          case "/fixture/poll":
            response = Response.json({
              userId: session.userId,
              passToken: session.passToken,
              ssecurity: session.ssecurity,
              location: "https://sts.api.io.mi.com/sts?fixture=login",
            });
            break;
          case "/pass/serviceLogin":
            response = redirect("https://account.xiaomi.com/sts/oauth");
            break;
          case "/sts/oauth":
            if (!authorization) throw new Error("OAuth start was not observed");
            response = redirect(authorization.href);
            break;
          case "/oauth2/userAuthorization": {
            if (!authorization) throw new Error("OAuth start was not observed");
            const followup = new URL(authorization);
            followup.searchParams.set("fixture", "consented");
            response = Response.json({
              code: 0,
              data: { followup: followup.href },
            });
            break;
          }
          case "/oauth2/authorize":
            if (url.searchParams.get("fixture") === "consented") {
              const callback = new URL("https://127.0.0.1/");
              callback.searchParams.set("code", "fixture-authorization-code");
              callback.searchParams.set(
                "state",
                url.searchParams.get("state") ?? "",
              );
              response = redirect(callback.href);
            } else if (url.searchParams.get("_json") === "true") {
              if (!authorization)
                throw new Error("OAuth start was not observed");
              response = Response.json({
                code: 0,
                data: {
                  pt: 0,
                  device_id: authorization.searchParams.get("device_id"),
                  followup: authorization.href,
                  scope_id: "fixture-scope",
                  redirect_uri: "https://127.0.0.1",
                  client_id: "2882303761520431603",
                  _ssign: "fixture-signature",
                },
              });
            } else {
              authorization = new URL(url);
              response = redirect(
                "https://account.xiaomi.com/pass/serviceLogin",
              );
            }
            break;
          default:
            throw new Error(`Unexpected account endpoint: ${url.pathname}`);
        }
      } else if (
        url.origin === "https://sts.api.io.mi.com" &&
        url.pathname === "/sts"
      ) {
        response = new Response("", {
          headers: {
            "set-cookie": `serviceToken=${session.serviceToken}; Path=/; Max-Age=3600; Secure`,
          },
        });
      } else if (
        url.origin === "https://mico.api.mijia.tech" &&
        url.pathname === "/app/v2/mico/oauth/get_token"
      ) {
        response = Response.json({
          code: 0,
          result: {
            access_token: `access-${session.userId}`,
            refresh_token: `refresh-${session.userId}`,
            expires_in: 3600,
          },
        });
      } else
        throw new Error(
          `Unexpected network endpoint: ${url.origin}${url.pathname}`,
        );
      return Promise.resolve(responseAt(url, response));
    },
    { preconnect: originalFetch.preconnect },
  );
  const request = spyOn(globalThis, "fetch").mockImplementation(implementation);
  return { calls, session, restore: () => request.mockRestore() };
}
