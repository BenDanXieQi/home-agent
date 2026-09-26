import { describe, expect, test } from "bun:test";
import { deviceSchema, entityKey, specSchema } from "@home-agent/api/household";
import {
  isImmutable,
  parseImmutable,
  produce,
} from "@home-agent/api/immutable";
import {
  directoryFits,
  initialProjectionState,
  prepareProjection,
  projectionBytes,
} from "../../src/household/capacity";
import { initialProjection } from "../../src/household/projection";
import { householdLimits, jsonBytes } from "../../src/household/config";
import { machineDirectory, runningMachine } from "../support/household-machine";

describe("bounded immutable household commits", () => {
  test("directory limits bound bytes and device count independently of lifecycle", () => {
    const directory = machineDirectory();
    expect(directoryFits(directory)).toBe(true);
    Object.values(directory.device)[0]!.name = "x".repeat(
      householdLimits.directoryBytes,
    );
    expect(directoryFits(directory)).toBe(false);
    const small = Object.values(machineDirectory().device)[0]!;
    const devices = Object.fromEntries(
      Array.from({ length: householdLimits.devices + 1 }, (_, index) => [
        String(index),
        small,
      ]),
    );
    expect(directoryFits({ home: {}, room: {}, device: devices })).toBe(false);
  });
  test("candidate preparation preserves input ownership until the detached commit is frozen", () => {
    const original = initialProjectionState(initialProjection());
    const directory = machineDirectory();
    const candidate = produce(original.projection, (draft) => {
      draft.device = directory.device;
    });
    expect(Object.isFrozen(Object.values(directory.device)[0])).toBe(false);
    const accepted = prepareProjection(original, candidate);
    const key = Object.keys(directory.device)[0]!;
    Object.values(directory.device)[0]!.name = "Changed";
    expect(accepted.projection.device[key]!.name).toBe("Sensor");
    expect(Object.isFrozen(accepted.projection.device[key])).toBe(true);
    expect(accepted.projection.home).toBe(original.projection.home);
  });
  test("immutable records reuse validation without bypassing identity checks", () => {
    const original = initialProjectionState(initialProjection());
    const device = parseImmutable(
      deviceSchema,
      Object.values(machineDirectory().device)[0],
    );
    const key = entityKey(device.account_id, device.id);
    const candidate = { ...original.projection, device: { [key]: device } };
    const first = prepareProjection(original, candidate);
    const second = prepareProjection(original, candidate);
    expect(second.projection.device[key]).toBe(first.projection.device[key]);
    expect(prepareProjection(second, candidate).projection).toBe(
      second.projection,
    );
    expect(() =>
      prepareProjection(second, { ...candidate, device: { wrong: device } }),
    ).toThrow();
  });
  test.each([false, true])(
    "shallow frozen input=%s revalidates mutable descendants",
    (frozen) => {
      const original = initialProjectionState(initialProjection());
      const device = Object.values(machineDirectory().device)[0]!;
      const key = entityKey(device.account_id, device.id);
      if (frozen) Object.freeze(device);
      expect(isImmutable(device)).toBe(false);
      const candidate = { ...original.projection, device: { [key]: device } };
      const before = prepareProjection(original, candidate);
      device.channels.push(1);
      const after = prepareProjection(before, candidate);
      expect(before.projection.device[key]!.channels).toEqual([]);
      expect(after.projection.device[key]!.channels).toEqual([1]);
    },
  );
  test("schema parsing detaches shallow frozen specifications", () => {
    const capability = {
      description: "Before",
      format: "float",
      readable: true,
      writeable: false,
      notify: true,
    };
    const input = Object.freeze({
      id: "spec-a",
      urn: "spec-a",
      version: "1",
      category: null,
      spec: { "prop.2.1": capability },
    });
    const spec = parseImmutable(specSchema, input);
    capability.description = "After";
    expect(spec.spec["prop.2.1"]!.description).toBe("Before");
    expect(Object.isFrozen(spec.spec["prop.2.1"])).toBe(true);
  });
  test("diagnostics measure UTF-8 bytes through add, replace, remove and no-op", () => {
    const original = initialProjectionState(initialProjection());
    const directory = machineDirectory();
    Object.values(directory.device)[0]!.name = "温度😀";
    const added = prepareProjection(original, {
      ...original.projection,
      ...directory,
    });
    expect(projectionBytes(added.projection).projection).toBe(
      jsonBytes(added.projection),
    );
    const unchanged = prepareProjection(added, {
      ...added.projection,
      device: { ...added.projection.device },
    });
    expect(unchanged.projection).toBe(added.projection);
    const removed = prepareProjection(unchanged, {
      ...unchanged.projection,
      device: {},
    });
    expect(removed.changes).toMatchObject([{ op: "remove", entity: "device" }]);
    expect(projectionBytes(removed.projection).projection).toBe(
      jsonBytes(removed.projection),
    );
  });
  test("commit whitelist strips private fields and freezes accepted public values", () => {
    const original = initialProjectionState(initialProjection());
    const candidate = {
      ...original.projection,
      login: {
        login: {
          ...original.projection.login.login,
          material_version: 7,
          token: "private",
        },
      },
    };
    const accepted = prepareProjection(original, candidate);
    expect(accepted.projection.login.login).not.toHaveProperty("token");
    expect(Object.isFrozen(accepted.projection.login.login)).toBe(true);
    for (const key of ["spec", "latest", "source_health", "rule_status"])
      expect(accepted.projection).not.toHaveProperty(key);
    expect(accepted.projection.household.household.homes).not.toHaveProperty(
      "items",
    );
  });
  test("record keys cannot mutate object prototypes", () => {
    const original = initialProjectionState(initialProjection());
    const device = Object.values(machineDirectory().device)[0]!;
    expect(() =>
      prepareProjection(original, {
        ...original.projection,
        device: Object.fromEntries([["__proto__", device]]),
      }),
    ).toThrow();
    expect(Object.getPrototypeOf(original.projection.device)).toBe(
      Object.prototype,
    );
  });
});

test("oversized source profile cannot block authorization cleanup", () => {
  const { actor, source } = runningMachine();
  try {
    const before = actor.getSnapshot().context;
    actor.send({
      type: "source",
      state: {
        ...source,
        account: {
          ...source.account,
          profile: {
            name: "x".repeat(householdLimits.metadataBytes),
            avatarUrl: null,
          },
        },
      },
    });
    const after = actor.getSnapshot().context;
    expect(after.projection.account.account).toEqual(
      before.projection.account.account,
    );
    expect(
      after.projection.projection_health.projection_health.capacity_degraded,
    ).toBe(true);
    actor.send({
      type: "command",
      scope_epoch: after.scope_epoch,
      effect: { kind: "logout" },
    });
    expect(actor.getSnapshot().context.projection.device).toEqual({});
    expect(actor.getSnapshot().context.effects).toEqual([{ kind: "logout" }]);
  } finally {
    actor.stop();
  }
});

test("no-op commands dispatch once without advancing the public version; stale input dispatches nothing", () => {
  const { actor } = runningMachine();
  const before = actor.getSnapshot().context;
  const effects: unknown[] = [];
  let handled = before.input_sequence;
  const subscription = actor.subscribe(({ context }) => {
    if (context.input_sequence === handled) return;
    handled = context.input_sequence;
    effects.push(...context.effects);
  });
  actor.send({
    type: "command",
    scope_epoch: before.scope_epoch,
    effect: { kind: "refresh", target: "directory" },
  });
  actor.send({
    type: "command",
    scope_epoch: crypto.randomUUID(),
    effect: { kind: "refresh", target: "specs" },
  });
  expect(effects).toEqual([{ kind: "refresh", target: "directory" }]);
  expect(actor.getSnapshot().context.sequence).toBe(before.sequence);
  subscription.unsubscribe();
  actor.stop();
});
