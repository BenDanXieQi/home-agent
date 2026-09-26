import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { specSchema } from "@home-agent/api/household";
import { parseImmutable } from "@home-agent/api/immutable";
import {
  HouseholdSpecifications,
  specificationBytes,
} from "../../../src/household/specifications";
import { MiCloudError } from "../../../src/mijia/protocols/micloud";
import { MiotSpecClient } from "../../../src/mijia/protocols/spec/client";
import { createMijiaSpecificationLoader } from "../../../src/mijia/household";
import { deferred, eventually, nextTurn } from "../../support/async";
import {
  preparedSpec,
  specInstance,
  specUrn,
} from "../../support/protocol-fixtures";

let specClient: MiotSpecClient;
beforeEach(() => {
  specClient = new MiotSpecClient(4 * 1024 * 1024);
});

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) restore();
});

function device(id: string, model = "test.sensor.contract") {
  return {
    id,
    model,
    spec_type: null,
  } satisfies Parameters<HouseholdSpecifications["update"]>[0][number];
}

function specifications(
  capacity: ConstructorParameters<typeof HouseholdSpecifications>[2] = () =>
    true,
) {
  const changed = mock(() => {});
  const owner = new HouseholdSpecifications(
    createMijiaSpecificationLoader(specClient),
    changed,
    capacity,
  );
  restores.push(() => owner.clear());
  return { owner, changed };
}

function metadata(urn = specUrn) {
  const spec = preparedSpec();
  return { urn, category: spec.category, spec: spec.spec } satisfies Awaited<
    ReturnType<MiotSpecClient["read"]>
  >;
}

describe("active household specifications", () => {
  test("specification limits count escaped UTF-8 values exactly across replacement and removal", () => {
    const first = parseImmutable(specSchema, {
      ...metadata(),
      id: specUrn,
      version: "1",
      category: '温度"\\\n',
    });
    const secondUrn = specUrn.replace(/:1$/, ":2");
    const second = parseImmutable(specSchema, {
      ...metadata(secondUrn),
      id: secondUrn,
      version: "2",
      category: "湿度🌧️",
    });
    for (const specs of [
      {},
      { [first.id]: first },
      { [first.id]: first, [second.id]: second },
      { [second.id]: second },
    ])
      expect(specificationBytes(specs)).toBe(
        Buffer.byteLength(JSON.stringify(specs)),
      );

    const mutable = specSchema.parse(first);
    const specs = { [mutable.id]: mutable };
    const before = specificationBytes(specs);
    mutable.spec["prop.2.1"]!.description += "更多资料";
    expect(specificationBytes(specs)).toBeGreaterThan(before);
    expect(specificationBytes(specs)).toBe(
      Buffer.byteLength(JSON.stringify(specs)),
    );
  });

  test("independently injected clients keep same-URN metadata isolated", async () => {
    const firstClient = new MiotSpecClient(4 * 1024 * 1024);
    const secondClient = new MiotSpecClient(4 * 1024 * 1024);
    const owners = [firstClient, secondClient].map((client, index) => {
      const resolve = spyOn(client, "resolve").mockImplementation(
        (_device, signal) =>
          Promise.resolve({ urn: specUrn, requestSignal: signal }),
      );
      const read = spyOn(client, "read").mockResolvedValue({
        ...metadata(),
        category: `sensor-${index}`,
      });
      const owner = new HouseholdSpecifications(
        createMijiaSpecificationLoader(client),
        () => {},
        () => true,
      );
      restores.push(
        () => resolve.mockRestore(),
        () => read.mockRestore(),
        () => owner.clear(),
      );
      owner.update([device("a")]);
      return owner;
    });
    await Promise.all(owners.map((owner) => owner.refresh()));
    expect(
      owners.map((owner) => owner.snapshot().specs[specUrn]?.category),
    ).toEqual(["sensor-0", "sensor-1"]);
    owners[0]!.clear();
    expect(owners[1]!.isApplicable("a", device("a").model)).toBe(true);
  });

  test("different models resolving to one URN share accepted capabilities and disappear with their last reference", async () => {
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (_device, signal) =>
        Promise.resolve({ urn: specUrn, requestSignal: signal }),
    );
    const read = spyOn(specClient, "read").mockResolvedValue(metadata());
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const { owner } = specifications();
    owner.update([device("a", "model-a"), device("b", "model-b")]);
    await eventually(
      () =>
        owner.snapshot().references.size === 2 &&
        [...owner.snapshot().references.values()].every(
          (reference) => reference.spec_status === "ready",
        ),
    );
    expect(Object.keys(owner.snapshot().specs)).toEqual([specUrn]);
    expect([...owner.snapshot().references.entries()]).toEqual([
      ["a", { spec_id: specUrn, spec_status: "ready", spec_error: null }],
      ["b", { spec_id: specUrn, spec_status: "ready", spec_error: null }],
    ]);
    const reads = read.mock.calls.length;
    owner.update([
      device("a", "model-a"),
      device("b", "model-b"),
      device("c", "model-a"),
    ]);
    await eventually(
      () => owner.snapshot().references.get("c")?.spec_status === "ready",
    );
    expect(read.mock.calls.length).toBe(reads);
    expect(owner.isApplicable("c", "model-a")).toBe(true);
    owner.update([device("b", "model-b")]);
    expect([...owner.snapshot().references.keys()]).toEqual(["b"]);
    expect(Object.keys(owner.snapshot().specs)).toEqual([specUrn]);
    owner.update([]);
    expect(owner.snapshot().specs).toEqual({});
    expect(owner.snapshot().references.size).toBe(0);
  });

  test("failed refresh after a changed model-to-URN mapping retains display metadata without authorizing old abilities", async () => {
    const nextUrn = specUrn.replace(/:1$/, ":2");
    const resolve = spyOn(specClient, "resolve")
      .mockImplementationOnce((_device, signal) =>
        Promise.resolve({ urn: specUrn, requestSignal: signal }),
      )
      .mockImplementation((_device, signal) =>
        Promise.resolve({ urn: nextUrn, requestSignal: signal }),
      );
    const read = spyOn(specClient, "read")
      .mockResolvedValueOnce(metadata())
      .mockRejectedValue(new MiCloudError("spec-invalid-response"));
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const { owner } = specifications();
    owner.update([device("a")]);
    await eventually(
      () => owner.snapshot().references.get("a")?.spec_status === "ready",
    );
    const accepted = owner.snapshot().specs[specUrn]!;
    expect(owner.isApplicable("a", device("a").model)).toBe(true);
    void owner.refresh();
    await eventually(() =>
      [...owner.snapshot().references.values()].some(
        (reference) => reference.spec_status === "error",
      ),
    );
    const failed = Object.values(owner.snapshot().specs)[0];
    expect(owner.snapshot().references.get("a")).toMatchObject({
      spec_id: specUrn,
      spec_status: "error",
    });
    expect(failed).toMatchObject({
      urn: accepted.urn,
      version: accepted.version,
      category: accepted.category,
      spec: accepted.spec,
    });
    expect(failed).toBe(accepted);
    expect(failed?.urn).not.toBe(nextUrn);
    expect(owner.isApplicable("a", device("a").model)).toBe(false);
    const reads = read.mock.calls.length;
    owner.update([device("a")]);
    await nextTurn();
    expect(read.mock.calls.length).toBe(reads);
    expect(owner.snapshot().references.get("a")?.spec_status).toBe("error");
    expect(owner.isApplicable("a", device("a").model)).toBe(false);
  });

  test("a failed model lookup does not mark another device using the same accepted URN as failed", async () => {
    let refreshing = false;
    const modelRequests: string[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url = new URL(
            input instanceof Request ? input.url : input.toString(),
          );
          if (url.pathname === "/internal/urn-by-model-version") {
            const model = url.searchParams.get("model")!;
            modelRequests.push(model);
            return refreshing && model === "model-a"
              ? new Response(null, { status: 404 })
              : Response.json({ urn: specUrn });
          }
          if (url.pathname === "/miot-spec-v2/instance")
            return Response.json(specInstance());
          if (url.pathname === "/instance/v2/multiLanguage")
            return Response.json({ data: {} });
          throw new Error(`Unexpected metadata endpoint: ${url.pathname}`);
        },
        { preconnect: fetch.preconnect },
      ),
    );
    restores.push(() => request.mockRestore());
    const { owner } = specifications();
    owner.update([device("a", "model-a"), device("b", "model-b")]);
    await owner.refresh();
    expect([...owner.snapshot().references.values()]).toEqual([
      { spec_id: specUrn, spec_status: "ready", spec_error: null },
      { spec_id: specUrn, spec_status: "ready", spec_error: null },
    ]);
    const accepted = owner.snapshot().specs[specUrn]!;

    refreshing = true;
    const refresh = owner.refresh();
    expect(owner.snapshot().specs[specUrn]).toBe(accepted);
    await refresh;
    const snapshot = owner.snapshot();
    expect(modelRequests).toEqual(["model-a", "model-b", "model-a", "model-b"]);
    expect(snapshot.references.get("a")).toMatchObject({
      spec_id: specUrn,
      spec_status: "error",
      spec_error: { code: "mijia_spec_unavailable" },
    });
    expect(snapshot.references.get("b")).toEqual({
      spec_id: specUrn,
      spec_status: "ready",
      spec_error: null,
    });
    expect(Object.keys(snapshot.specs)).toEqual([specUrn]);
    expect(snapshot.specs[specUrn]).toEqual(accepted);
    expect(snapshot.specs[specUrn]).not.toHaveProperty("status");
    expect(snapshot.specs[specUrn]).not.toHaveProperty("error");
    expect(owner.isApplicable("a", "model-a")).toBe(true);
    expect(owner.isApplicable("b", "model-b")).toBe(true);
  });

  test("a removed source's late response cannot restore its reference or evict active specifications", async () => {
    const late = deferred<Awaited<ReturnType<MiotSpecClient["read"]>>>();
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (_device, signal) =>
        Promise.resolve({ urn: specUrn, requestSignal: signal }),
    );
    const read = spyOn(specClient, "read").mockImplementation(
      () => late.promise,
    );
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const { owner, changed } = specifications();
    owner.update([device("removed")]);
    await eventually(() => read.mock.calls.length === 1);
    const signal = read.mock.calls[0]![1];
    owner.update([]);
    expect(signal.aborted).toBe(true);
    late.resolve(metadata());
    await nextTurn();
    expect(owner.snapshot().specs).toEqual({});
    expect(changed).not.toHaveBeenCalled();
  });

  test("a capacity-rejected refresh preserves accepted abilities and other devices until a later refresh fits", async () => {
    const nextUrn = specUrn.replace(/:1$/, ":2");
    const stableUrn = specUrn.replace("test-contract", "stable-contract");
    let currentUrn = specUrn;
    let capacityBytes = 4_096;
    const updated = metadata(nextUrn);
    updated.spec["prop.2.4"] = {
      ...updated.spec["prop.2.1"]!,
      description: "Expanded device capability ".repeat(256),
    };
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (item, signal) =>
        Promise.resolve({
          urn: item.model === "stable-model" ? stableUrn : currentUrn,
          requestSignal: signal,
        }),
    );
    const read = spyOn(specClient, "read").mockImplementation(({ urn }) =>
      Promise.resolve(urn === nextUrn ? updated : metadata(urn)),
    );
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const { owner } = specifications(
      ({ specs }) => Buffer.byteLength(JSON.stringify(specs)) <= capacityBytes,
    );
    const devices = [device("changing"), device("stable", "stable-model")];
    owner.update(devices);
    await eventually(
      () =>
        owner.snapshot().references.get("changing")?.spec_status === "ready" &&
        owner.snapshot().references.get("stable")?.spec_status === "ready",
    );
    const accepted = owner.snapshot().specs[specUrn]!;
    const stable = owner.snapshot().specs[stableUrn]!;

    currentUrn = nextUrn;
    void owner.refresh();
    await eventually(
      () =>
        [...owner.snapshot().references.values()].some(
          (reference) => reference.spec_status === "error",
        ) && owner.snapshot().references.get("stable")?.spec_status === "ready",
    );
    const rejected = owner.snapshot();
    const rejectedId = rejected.references.get("changing")!.spec_id!;
    expect(rejected.references.get("changing")).toMatchObject({
      spec_id: specUrn,
      spec_status: "error",
    });
    expect(rejected.specs[rejectedId]).toMatchObject({
      urn: accepted.urn,
      version: accepted.version,
      category: accepted.category,
      spec: accepted.spec,
    });
    expect(rejected.specs[rejectedId]?.spec).not.toHaveProperty("prop.2.4");
    expect(rejected.references.get("stable")).toEqual({
      spec_id: stableUrn,
      spec_status: "ready",
      spec_error: null,
    });
    expect(rejected.specs[stableUrn]).toEqual(stable);
    expect(rejected.specs[nextUrn]).toBeUndefined();

    capacityBytes = 16_384;
    void owner.refresh();
    await eventually(
      () =>
        owner.snapshot().references.get("changing")?.spec_status === "ready",
    );
    const recovered = owner.snapshot();
    expect(recovered.references.get("changing")).toEqual({
      spec_id: nextUrn,
      spec_status: "ready",
      spec_error: null,
    });
    expect(recovered.specs[nextUrn]).toMatchObject({
      version: "2",
      spec: updated.spec,
    });
    expect(recovered.specs[stableUrn]).toEqual(stable);
    expect(recovered.specs[specUrn]).toBeUndefined();
  });
});

describe("specification refresh ownership", () => {
  test("refresh still fetches and finishes truthfully when new metadata cannot be admitted", async () => {
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (_item, signal) =>
        Promise.resolve({ urn: specUrn, requestSignal: signal }),
    );
    const read = spyOn(specClient, "read").mockResolvedValue(metadata());
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    let allowMetadata = true;
    const { owner } = specifications(() => allowMetadata);
    const current = device("a");
    owner.update([current]);
    await owner.refresh();
    const accepted = owner.snapshot().specs[specUrn];
    const reads = read.mock.calls.length;

    allowMetadata = false;
    const refreshing = owner.refresh();
    expect(owner.snapshot().references.get(current.id)?.spec_status).toBe(
      "loading",
    );
    await refreshing;
    expect(read.mock.calls.length).toBe(reads + 1);
    expect(owner.snapshot().references.get(current.id)).toMatchObject({
      spec_status: "error",
      spec_error: { code: "mijia_capacity_exceeded" },
    });
    expect(owner.snapshot().specs[specUrn]).toBe(accepted);
    expect(owner.isApplicable(current.id, current.model)).toBe(true);

    read.mockRejectedValue(new MiCloudError("spec-invalid-response"));
    await owner.refresh();
    expect(read.mock.calls.length).toBe(reads + 2);
    expect(owner.snapshot().references.get(current.id)).toMatchObject({
      spec_status: "error",
      spec_error: { code: "mijia_spec_invalid_response" },
    });
    expect(owner.isApplicable(current.id, current.model)).toBe(true);
  });

  test("a new definition is installed and its failed task completes even when metadata admission is unavailable", async () => {
    let lookupAllowed = true;
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (_item, signal) =>
        lookupAllowed
          ? Promise.resolve({ urn: specUrn, requestSignal: signal })
          : Promise.reject(new MiCloudError("spec-unavailable")),
    );
    const read = spyOn(specClient, "read")
      .mockResolvedValueOnce(metadata())
      .mockRejectedValue(new MiCloudError("spec-invalid-response"));
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    let allowMetadata = true;
    const { owner } = specifications(() => allowMetadata);
    owner.update([device("a", "old-model")]);
    await owner.refresh();
    const accepted = owner.snapshot().specs[specUrn];

    allowMetadata = false;
    lookupAllowed = false;
    owner.update([device("a", "new-model")]);
    expect(owner.isApplicable("a", "old-model")).toBe(false);
    expect(owner.isApplicable("a", "new-model")).toBe(false);
    await owner.refresh();
    expect(resolve.mock.calls.at(-1)?.[0].model).toBe("new-model");
    expect(owner.snapshot().references.get("a")).toMatchObject({
      spec_id: specUrn,
      spec_status: "error",
      spec_error: { code: "mijia_spec_unavailable" },
    });
    expect(owner.snapshot().specs[specUrn]).toBe(accepted);
    expect(owner.isApplicable("a", "new-model")).toBe(false);

    // The new model now resolves to the retained URN. Its refresh may fail,
    // but the retained metadata has been verified against the new definition.
    lookupAllowed = true;
    await owner.refresh();
    expect(owner.snapshot().references.get("a")?.spec_status).toBe("error");
    expect(owner.isApplicable("a", "new-model")).toBe(true);
    expect(owner.isApplicable("a", "old-model")).toBe(false);
    expect(owner.snapshot().specs[specUrn]).toBe(accepted);
  });

  test("projection capacity checks proposed device references before replacing accepted metadata", async () => {
    const nextUrn = specUrn.replace(/:1$/, ":2");
    let currentUrn = specUrn;
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (_item, signal) =>
        Promise.resolve({ urn: currentUrn, requestSignal: signal }),
    );
    const read = spyOn(specClient, "read").mockImplementation(({ urn }) =>
      Promise.resolve(metadata(urn)),
    );
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const capacity = mock<
      ConstructorParameters<typeof HouseholdSpecifications>[2]
    >(({ references }) => references.get("a")?.spec_id !== nextUrn);
    const { owner } = specifications(capacity);
    owner.update([device("a")]);
    await eventually(
      () => owner.snapshot().references.get("a")?.spec_status === "ready",
    );
    const accepted = owner.snapshot().specs[specUrn]!.spec;
    currentUrn = nextUrn;
    await owner.refresh();
    expect(
      capacity.mock.calls.some(
        ([candidate]) => candidate.references.get("a")?.spec_id === nextUrn,
      ),
    ).toBe(true);
    expect(owner.snapshot().references.get("a")?.spec_id).toBe(specUrn);
    expect(owner.snapshot().references.get("a")?.spec_status).toBe("error");
    expect(owner.snapshot().specs[specUrn]).toMatchObject({
      version: "1",
    });
    expect(owner.snapshot().specs[specUrn]!.spec).toBe(accepted);
    expect(owner.snapshot().specs[nextUrn]).toBeUndefined();
  });

  test("directory repeats and duplicate refreshes share the original retry budget", async () => {
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (_item, signal) =>
        Promise.resolve({ urn: specUrn, requestSignal: signal }),
    );
    const read = spyOn(specClient, "read").mockRejectedValue(
      new MiCloudError("network"),
    );
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const { owner } = specifications();
    const devices = [device("a")];
    owner.update(devices);
    await eventually(() => read.mock.calls.length === 1);
    owner.update(devices);
    const first = owner.refresh();
    expect(owner.refresh()).toBe(first);
    await first;
    expect(read).toHaveBeenCalledTimes(3);
    expect(owner.snapshot().references.get("a")).toMatchObject({
      spec_id: null,
      spec_status: "error",
    });
    expect(owner.snapshot().specs).toEqual({});
    owner.update(devices);
    await nextTurn();
    expect(read).toHaveBeenCalledTimes(3);
  }, 15_000);

  test("at most three specification loads run while remaining sources wait", async () => {
    const pending = Array.from({ length: 4 }, () =>
      deferred<Awaited<ReturnType<MiotSpecClient["read"]>>>(),
    );
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (item, signal) =>
        Promise.resolve({
          urn: specUrn.replace("test-contract", item.model),
          requestSignal: signal,
        }),
    );
    const read = spyOn(specClient, "read").mockImplementation(({ urn }) => {
      const index = Number(urn.split(":").at(-2));
      return pending[index]!.promise;
    });
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const { owner } = specifications();
    owner.update(
      pending.map((_, index) => device(String(index), String(index))),
    );
    await eventually(() => read.mock.calls.length === 3);
    await nextTurn();
    expect(read).toHaveBeenCalledTimes(3);
    pending[0]!.resolve(metadata(specUrn.replace("test-contract", "0")));
    await eventually(() => read.mock.calls.length === 4);
    const firstUrn = specUrn.replace("test-contract", "0");
    const accepted = owner.snapshot().specs[firstUrn]!;
    for (const [index, request] of pending.entries())
      request.resolve(
        metadata(specUrn.replace("test-contract", String(index))),
      );
    await eventually(() =>
      [...owner.snapshot().references.values()].every(
        (reference) => reference.spec_status === "ready",
      ),
    );
    expect(
      [...owner.snapshot().references.values()].every(
        (reference) => reference.spec_status === "ready",
      ),
    ).toBe(true);
    expect(owner.snapshot().specs[firstUrn]).toBe(accepted);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.spec)).toBe(true);
  });

  test("failed refresh retains one shared accepted specification without subjecting task failure to metadata capacity", async () => {
    const large = metadata();
    large.spec["prop.2.1"]!.description = "x".repeat(1_400_000);
    let failed = false;
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (_device, signal) =>
        Promise.resolve({ urn: specUrn, requestSignal: signal }),
    );
    const read = spyOn(specClient, "read").mockImplementation(() =>
      failed
        ? Promise.reject(new MiCloudError("spec-invalid-response"))
        : Promise.resolve(large),
    );
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const capacity = mock<
      ConstructorParameters<typeof HouseholdSpecifications>[2]
    >(
      ({ specs }) =>
        Buffer.byteLength(JSON.stringify(specs)) <= 4 * 1024 * 1024,
    );
    const { owner } = specifications(capacity);
    const devices = ["a", "b", "c", "d"].map((id) => device(id, `model-${id}`));
    owner.update(devices);
    await eventually(
      () => owner.snapshot().references.get("a")?.spec_status === "ready",
    );
    await nextTurn();
    const accepted = owner.snapshot().specs[specUrn]!.spec;
    capacity.mockClear();
    failed = true;
    await owner.refresh();
    const snapshot = owner.snapshot();
    expect(Object.keys(snapshot.specs)).toEqual([specUrn]);
    expect(snapshot.specs[specUrn]).toMatchObject({
      version: "1",
    });
    expect(snapshot.specs[specUrn]!.spec).toBe(accepted);
    expect(Buffer.byteLength(JSON.stringify(snapshot.specs))).toBeLessThan(
      4 * 1024 * 1024,
    );
    expect(capacity).not.toHaveBeenCalled();
    for (const { id } of devices)
      expect(snapshot.references.get(id)).toMatchObject({
        spec_id: specUrn,
        spec_status: "error",
        spec_error: { code: "mijia_spec_invalid_response" },
      });
    owner.update([]);
    expect(owner.snapshot().specs).toEqual({});
  });

  test.each(["model", "spec_type"] as const)(
    "a changed directory %s retains old metadata for display until replacement succeeds",
    async (field) => {
      const nextUrn = specUrn.replace(/:1$/, ":2");
      let failing = false;
      const resolve = spyOn(specClient, "resolve").mockImplementation(
        (item, signal) =>
          Promise.resolve({
            urn:
              item.spec_type ??
              (item.model === "new-model" ? nextUrn : specUrn),
            requestSignal: signal,
          }),
      );
      const read = spyOn(specClient, "read").mockImplementation(({ urn }) =>
        failing
          ? Promise.reject(new MiCloudError("spec-invalid-response"))
          : Promise.resolve(metadata(urn)),
      );
      restores.push(
        () => resolve.mockRestore(),
        () => read.mockRestore(),
      );
      const { owner } = specifications();
      const initial = {
        ...device("a", "old-model"),
        spec_type: field === "spec_type" ? specUrn : null,
      };
      const replacement = {
        ...initial,
        [field]: field === "model" ? "new-model" : nextUrn,
      };
      owner.update([initial]);
      await eventually(
        () => owner.snapshot().references.get("a")?.spec_status === "ready",
      );
      const accepted = owner.snapshot().specs[specUrn]!.spec;
      failing = true;
      owner.update([replacement]);
      expect(owner.snapshot().references.get("a")?.spec_id).toBe(specUrn);
      expect(owner.snapshot().references.get("a")?.spec_status).toBe("loading");
      expect(owner.snapshot().specs[specUrn]!.spec).toBe(accepted);
      expect(owner.isApplicable(replacement.id, replacement.model)).toBe(false);
      await eventually(
        () => owner.snapshot().references.get("a")?.spec_status === "error",
      );
      expect(owner.snapshot().specs[specUrn]!.spec).toBe(accepted);
      expect(owner.isApplicable(replacement.id, replacement.model)).toBe(false);
      failing = false;
      await owner.refresh();
      expect(owner.snapshot().references.get("a")?.spec_id).toBe(nextUrn);
      expect(owner.snapshot().references.get("a")?.spec_status).toBe("ready");
      expect(owner.snapshot().specs[specUrn]).toBeUndefined();
      expect(owner.isApplicable(replacement.id, replacement.model)).toBe(true);
    },
  );

  test("duplicate refresh joins the whole batch while a slower specification remains pending", async () => {
    const slowUrn = specUrn.replace("test-contract", "slow-contract");
    const slow = deferred<Awaited<ReturnType<MiotSpecClient["read"]>>>();
    let refreshing = false;
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (item, signal) =>
        Promise.resolve({
          urn: item.model === "slow" ? slowUrn : specUrn,
          requestSignal: signal,
        }),
    );
    const read = spyOn(specClient, "read").mockImplementation(({ urn }) =>
      refreshing && urn === slowUrn
        ? slow.promise
        : Promise.resolve(metadata(urn)),
    );
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const { owner } = specifications();
    owner.update([device("a", "fast"), device("b", "slow")]);
    await eventually(() =>
      [...owner.snapshot().references.values()].every(
        (reference) => reference.spec_status === "ready",
      ),
    );
    await nextTurn();
    refreshing = true;
    read.mockClear();
    const first = owner.refresh();
    await eventually(
      () =>
        owner.snapshot().references.get("a")?.spec_status === "ready" &&
        read.mock.calls.length === 2,
    );
    const second = owner.refresh();
    expect(second).toBe(first);
    await nextTurn();
    expect(read).toHaveBeenCalledTimes(2);
    slow.resolve(metadata(slowUrn));
    await first;
    expect(owner.snapshot().references.get("b")?.spec_status).toBe("ready");
  });

  test("clearing a refresh cancels its source and settles all joined callers", async () => {
    const pending = deferred<Awaited<ReturnType<MiotSpecClient["read"]>>>();
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (_item, signal) =>
        Promise.resolve({ urn: specUrn, requestSignal: signal }),
    );
    const read = spyOn(specClient, "read")
      .mockResolvedValueOnce(metadata())
      .mockImplementation(() => pending.promise);
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const { owner } = specifications();
    owner.update([device("a")]);
    await eventually(
      () => owner.snapshot().references.get("a")?.spec_status === "ready",
    );
    await nextTurn();
    const refreshed = owner.refresh();
    await eventually(() => read.mock.calls.length === 2);
    const signal = read.mock.calls[1]![1];
    owner.clear();
    await refreshed;
    expect(signal.aborted).toBe(true);
    pending.resolve(metadata());
    await nextTurn();
    expect(owner.snapshot().specs).toEqual({});
    expect(owner.snapshot().references.size).toBe(0);
  });

  test("revocation releases the last reference even when new capacity is unavailable", async () => {
    const resolve = spyOn(specClient, "resolve").mockImplementation(
      (_item, signal) =>
        Promise.resolve({ urn: specUrn, requestSignal: signal }),
    );
    const read = spyOn(specClient, "read").mockResolvedValue(metadata());
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    let capacityAvailable = true;
    const capacity = mock(() => capacityAvailable);
    const { owner } = specifications(capacity);
    owner.update([device("a"), device("b")]);
    await eventually(
      () => owner.snapshot().references.get("a")?.spec_status === "ready",
    );
    capacityAvailable = false;
    capacity.mockClear();
    owner.retain(new Set(["b"]));
    expect([...owner.snapshot().references.keys()]).toEqual(["b"]);
    expect(Object.keys(owner.snapshot().specs)).toEqual([specUrn]);
    owner.retain(new Set());
    expect(owner.snapshot().specs).toEqual({});
    expect(capacity).not.toHaveBeenCalled();
  });
});
