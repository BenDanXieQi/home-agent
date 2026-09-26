import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { HouseholdSpecifications } from "../../../src/household/specifications";
import { MiCloudError } from "../../../src/mijia/protocols/micloud";
import { MiotSpecClient } from "../../../src/mijia/protocols/micloud/spec";
import { deferred, eventually, nextTurn } from "../../support/async";
import { preparedSpec, specUrn } from "../../support/protocol-fixtures";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) restore();
});

function device(id: string, model = "test.sensor.contract") {
  return {
    id,
    model,
    name: id,
    home_id: "home-a",
    home_name: "Home A",
    room_id: null,
    room_name: null,
    online: false,
    camera: false,
    channels: [],
    spec_type: null,
  } satisfies Parameters<HouseholdSpecifications["update"]>[0][number];
}

function specifications(
  capacity: ConstructorParameters<typeof HouseholdSpecifications>[1] = () =>
    true,
) {
  const changed = mock(() => {});
  const owner = new HouseholdSpecifications(changed, capacity);
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
  test("different models resolving to one URN share accepted capabilities and disappear with their last reference", async () => {
    const resolve = spyOn(
      MiotSpecClient.prototype,
      "resolve",
    ).mockImplementation((_device, signal) =>
      Promise.resolve({ urn: specUrn, requestSignal: signal }),
    );
    const read = spyOn(MiotSpecClient.prototype, "read").mockResolvedValue(
      metadata(),
    );
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const { owner } = specifications();
    owner.update([device("a", "model-a"), device("b", "model-b")]);
    await eventually(
      () =>
        owner.snapshot().references.size === 2 &&
        Object.values(owner.snapshot().specs).every(
          (spec) => spec.status === "ready",
        ),
    );
    expect(Object.keys(owner.snapshot().specs)).toEqual([specUrn]);
    expect([...owner.snapshot().references.entries()]).toEqual([
      ["a", specUrn],
      ["b", specUrn],
    ]);
    owner.update([device("b", "model-b")]);
    expect([...owner.snapshot().references.keys()]).toEqual(["b"]);
    expect(Object.keys(owner.snapshot().specs)).toEqual([specUrn]);
    owner.update([]);
    expect(owner.snapshot().specs).toEqual({});
    expect(owner.snapshot().references.size).toBe(0);
  });

  test("failed refresh after a changed model-to-URN mapping preserves old version and abilities", async () => {
    const nextUrn = specUrn.replace(/:1$/, ":2");
    const resolve = spyOn(MiotSpecClient.prototype, "resolve")
      .mockImplementationOnce((_device, signal) =>
        Promise.resolve({ urn: specUrn, requestSignal: signal }),
      )
      .mockImplementation((_device, signal) =>
        Promise.resolve({ urn: nextUrn, requestSignal: signal }),
      );
    const read = spyOn(MiotSpecClient.prototype, "read")
      .mockResolvedValueOnce(metadata())
      .mockRejectedValue(new MiCloudError("spec-invalid-response"));
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const { owner } = specifications();
    owner.update([device("a")]);
    await eventually(() => owner.snapshot().specs[specUrn]?.status === "ready");
    const accepted = owner.snapshot().specs[specUrn]!;
    owner.update([device("a")], true);
    await eventually(() =>
      Object.values(owner.snapshot().specs).some(
        (spec) => spec.status === "error",
      ),
    );
    const failed = Object.values(owner.snapshot().specs)[0];
    expect(failed).toMatchObject({
      status: "error",
      urn: accepted.urn,
      version: accepted.version,
      category: accepted.category,
      spec: accepted.spec,
    });
    expect(failed?.urn).not.toBe(nextUrn);
  });

  test("a removed group's late response cannot restore its reference or evict active specifications", async () => {
    const late = deferred<Awaited<ReturnType<MiotSpecClient["read"]>>>();
    const resolve = spyOn(
      MiotSpecClient.prototype,
      "resolve",
    ).mockImplementation((_device, signal) =>
      Promise.resolve({ urn: specUrn, requestSignal: signal }),
    );
    const read = spyOn(MiotSpecClient.prototype, "read").mockImplementation(
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
    const resolve = spyOn(
      MiotSpecClient.prototype,
      "resolve",
    ).mockImplementation((item, signal) =>
      Promise.resolve({
        urn: item.model === "stable-model" ? stableUrn : currentUrn,
        requestSignal: signal,
      }),
    );
    const read = spyOn(MiotSpecClient.prototype, "read").mockImplementation(
      ({ urn }) => Promise.resolve(urn === nextUrn ? updated : metadata(urn)),
    );
    restores.push(
      () => resolve.mockRestore(),
      () => read.mockRestore(),
    );
    const { owner } = specifications((bytes) => bytes <= capacityBytes);
    const devices = [device("changing"), device("stable", "stable-model")];
    owner.update(devices);
    await eventually(
      () =>
        owner.snapshot().specs[specUrn]?.status === "ready" &&
        owner.snapshot().specs[stableUrn]?.status === "ready",
    );
    const accepted = owner.snapshot().specs[specUrn]!;
    const stable = owner.snapshot().specs[stableUrn]!;

    currentUrn = nextUrn;
    owner.update(devices, true);
    await eventually(
      () =>
        Object.values(owner.snapshot().specs).some(
          (spec) => spec.status === "error",
        ) && owner.snapshot().specs[stableUrn]?.status === "ready",
    );
    const rejected = owner.snapshot();
    const rejectedId = rejected.references.get("changing")!;
    expect(rejected.specs[rejectedId]).toMatchObject({
      status: "error",
      urn: accepted.urn,
      version: accepted.version,
      category: accepted.category,
      spec: accepted.spec,
    });
    expect(rejected.specs[rejectedId]?.spec).not.toHaveProperty("prop.2.4");
    expect(rejected.references.get("stable")).toBe(stableUrn);
    expect(rejected.specs[stableUrn]).toEqual(stable);
    expect(rejected.specs[nextUrn]).toBeUndefined();

    capacityBytes = 16_384;
    owner.update(devices, true);
    await eventually(() => owner.snapshot().specs[nextUrn]?.status === "ready");
    const recovered = owner.snapshot();
    expect(recovered.references.get("changing")).toBe(nextUrn);
    expect(recovered.specs[nextUrn]).toMatchObject({
      version: "2",
      spec: updated.spec,
      error: null,
    });
    expect(recovered.specs[stableUrn]).toEqual(stable);
    expect(recovered.specs[specUrn]).toBeUndefined();
  });
});
