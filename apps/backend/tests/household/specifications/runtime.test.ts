import { expect, test } from "bun:test";
import { entityKey } from "@home-agent/api/household";
import { HouseholdRuntime } from "../../../src/household/runtime";
import { MijiaError } from "../../../src/mijia/errors";
import { deferred, eventually } from "../../support/async";
import {
  machineDirectory,
  machineSource,
} from "../../support/household-machine";
import { preparedSpec, specUrn } from "../../support/protocol-fixtures";

test("shared metadata reaches a pending or failed source without replacing unrelated device records", async () => {
  const source = machineSource();
  const template = Object.values(machineDirectory().device)[0]!;
  const devices = ["a", "b", "c"].map((id) => ({
    ...template,
    id: `device-${id}`,
    model: `model-${id}`,
    spec_type: null,
  }));
  const initial = preparedSpec();
  const metadata = {
    urn: specUrn,
    category: initial.category,
    spec: initial.spec,
  };
  const updated = {
    ...metadata,
    category: "updated-sensor",
    spec: {
      "prop.2.1": {
        ...initial.spec["prop.2.1"]!,
        readable: false,
        notify: true,
      },
    },
  };
  const first = deferred<typeof metadata>();
  const second = deferred<typeof metadata>();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const failure = new MijiaError("spec_invalid_response").toPayload();
  let refreshing = false;
  const runtime = new HouseholdRuntime(
    {
      snapshot: () => source,
      subscribe: () => () => {},
      bindHome: async () => {},
      refreshDirectory: async () => {},
      logout: async () => {},
      close: async () => {},
      reservePlayback: () => {
        throw new Error("Playback is outside this fixture");
      },
      failure: () => failure,
    },
    {
      read: async () => undefined,
      save: async () => "2026-09-01T00:00:00.000Z",
    },
    {
      resolve: async (device) => {
        const urn =
          device.model === "model-c"
            ? specUrn.replace("test-contract", "unrelated")
            : specUrn;
        return {
          urn,
          read: async () => {
            if (refreshing && device.model === "model-a") {
              firstStarted.resolve();
              return first.promise;
            }
            if (refreshing && device.model === "model-b") {
              secondStarted.resolve();
              return second.promise;
            }
            return { ...metadata, urn };
          },
        };
      },
      failure: () => ({ error: failure, retryable: false }),
    },
  );
  const device = (id: string) =>
    runtime.snapshot().projection.device[entityKey(source.account_id, id)]!;
  runtime.start();
  try {
    const commit = await runtime.commitDirectory(
      {
        accountId: source.account_id,
        homeId: source.homes.selectedHomeId,
        homes: source.homes.items.map((home) => ({ ...home, rooms: [] })),
        devices,
      },
      () => {},
    );
    commit();
    await eventually(() =>
      devices.every((item) => device(item.id).spec_status === "ready"),
    );
    expect(device("device-b").spec_id).toBe(specUrn);
    expect(device("device-b").capability_tags).toEqual([
      "readable",
      "writeable",
      "notify",
    ]);

    refreshing = true;
    runtime.requestRefresh(runtime.epoch, "specs");
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    await eventually(() => device("device-c").spec_status === "ready");
    const unrelated = device("device-c");
    expect(device("device-a").spec_status).toBe("loading");
    expect(device("device-b").spec_status).toBe("loading");

    first.resolve(updated);
    await eventually(() => device("device-a").spec_status === "ready");
    expect(device("device-b")).toMatchObject({
      spec_id: specUrn,
      spec_status: "loading",
      spec_error: null,
      category: "updated-sensor",
      capability_tags: ["notify"],
    });
    expect(device("device-c")).toBe(unrelated);

    second.reject(new Error("Second source refresh failed"));
    await eventually(() => device("device-b").spec_status === "error");
    expect(device("device-b")).toMatchObject({
      spec_id: specUrn,
      spec_error: failure,
      category: "updated-sensor",
      capability_tags: ["notify"],
    });
    expect(runtime.specification("device-b").category).toBe("updated-sensor");
    expect(device("device-c")).toBe(unrelated);
  } finally {
    first.resolve(metadata);
    second.resolve(metadata);
    await runtime.close();
  }
});
