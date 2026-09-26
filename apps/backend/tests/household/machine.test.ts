import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createActor } from "xstate";
import { householdMachine } from "../../src/household/machine";
import { householdLimits } from "../../src/household/config";
import { upsertChangeSchema, type Projection } from "@home-agent/api/household";
import {
  commitMachineDirectory,
  machineDirectory,
  machineSource,
  runningMachine,
} from "../support/household-machine";

const actors: ReturnType<typeof runningMachine>["actor"][] = [];
afterEach(() => {
  for (const actor of actors.splice(0)) actor.stop();
});

function start() {
  const actor = createActor(householdMachine).start();
  actors.push(actor);
  return actor;
}
function running() {
  const fixture = runningMachine();
  actors.push(fixture.actor);
  return fixture;
}
function expectLifecycle(
  actor: ReturnType<typeof start>,
  lifecycle: Projection["household"]["household"]["status"],
) {
  const snapshot = actor.getSnapshot();
  expect(snapshot.matches(lifecycle)).toBe(true);
  expect(snapshot.context.projection.household.household.status).toBe(
    lifecycle,
  );
  return snapshot.context;
}

describe("semantic household lifecycle", () => {
  test("a bound household rejects another binding without changing its running scope", () => {
    const { actor } = running();
    const previous = actor.getSnapshot().context;
    actor.send({
      type: "bound",
      scope_epoch: previous.scope_epoch,
      home_id: "home-b",
    });
    expect(actor.getSnapshot().context).toBe(previous);
    expectLifecycle(actor, "running");
  });

  test("restores cached ownership and waits for authenticated complete directory before running", () => {
    const actor = start();
    const source = machineSource();
    const initial = expectLifecycle(actor, "unbound");
    actor.send({
      type: "restore",
      scope_epoch: initial.scope_epoch,
      provider: source.provider,
      account_id: source.account_id,
      home_id: "home-a",
      directory: machineDirectory(),
      saved_at: "2026-09-01T00:00:00.000Z",
    });
    const cached = expectLifecycle(actor, "initializing");
    expect(cached.scope_epoch).toBe(initial.scope_epoch);
    expect(cached.cached).toBe(true);
    expect(cached.projection.household.household.sync_status).toBe("unsynced");
    expect(Object.keys(cached.projection.device)).toHaveLength(1);

    commitMachineDirectory(actor);
    expect(actor.getSnapshot().context).toEqual(cached);
    actor.send({ type: "source", state: source });
    const authenticated = expectLifecycle(actor, "initializing");
    expect(authenticated.scope_epoch).toBe(initial.scope_epoch);
    expect(authenticated.projection.device).toBe(cached.projection.device);
    commitMachineDirectory(actor);
    const ready = expectLifecycle(actor, "running");
    expect(ready.cached).toBe(false);
    expect(ready.projection.household.household.sync_status).toBe("synced");
  });

  test("first setup binds once without replacing the account scope", () => {
    const actor = start();
    actor.send({
      type: "source",
      state: {
        ...machineSource(),
        homes: { selectedHomeId: null, status: "unselected", items: [] },
      },
    });
    commitMachineDirectory(actor, null);
    const waiting = expectLifecycle(actor, "waiting_for_home");
    actor.send({
      type: "bound",
      scope_epoch: crypto.randomUUID(),
      home_id: "home-b",
    });
    expect(actor.getSnapshot().context).toBe(waiting);
    actor.send({
      type: "bound",
      scope_epoch: waiting.scope_epoch,
      home_id: "home-b",
    });
    const bound = expectLifecycle(actor, "initializing");
    expect(bound.scope_epoch).toBe(waiting.scope_epoch);
    expect(bound.projection.household.household.home_id).toBe("home-b");
    commitMachineDirectory(actor, "home-b");
    expectLifecycle(actor, "running");
  });

  test("renewed source details preserve running scope; a different account instance clears its directory", () => {
    const { actor, source } = running();
    const before = expectLifecycle(actor, "running");
    actor.send({
      type: "source",
      state: {
        ...source,
        media: { ...source.media, revision: crypto.randomUUID() },
      },
    });
    const renewed = expectLifecycle(actor, "running");
    expect(renewed.scope_epoch).toBe(before.scope_epoch);
    expect(renewed.projection.device).toBe(before.projection.device);
    expect(renewed.effects).toEqual([]);
    actor.send({
      type: "failure",
      scope_epoch: renewed.scope_epoch,
      stage: "directory",
      error: { code: "mijia_devices_failed", message: "Cloud failed" },
    });
    const failed = expectLifecycle(actor, "running");
    expect(failed.projection.device).toBe(before.projection.device);
    actor.send({
      type: "source",
      state: {
        ...source,
        account: { ...source.account, id: crypto.randomUUID() },
      },
    });
    const replaced = expectLifecycle(actor, "initializing");
    expect(replaced.scope_epoch).not.toBe(before.scope_epoch);
    expect(replaced.projection.device).toEqual({});
    expect(replaced.effects).toEqual([{ kind: "reset" }]);
  });

  test("home access loss and logout retain the fixed binding", () => {
    const { actor, source } = running();
    const before = actor.getSnapshot().context;
    actor.send({
      type: "revoke",
      scope_epoch: before.scope_epoch,
      homeLost: true,
      projection: {
        ...before.projection,
        home: {},
        room: {},
        device: {},
        household: {
          household: {
            ...before.projection.household.household,
            homes: { ...source.homes, status: "unavailable" },
            sync_status: "error",
            error: { code: "mijia_home_unavailable", message: "Home lost" },
          },
        },
      },
    });
    const revoked = expectLifecycle(actor, "initializing");
    expect(revoked.scope_epoch).not.toBe(before.scope_epoch);
    expect(revoked.effects).toEqual([{ kind: "reset" }]);
    actor.send({
      type: "command",
      scope_epoch: revoked.scope_epoch,
      effect: { kind: "logout" },
    });
    const leaving = expectLifecycle(actor, "initializing");
    expect(leaving.scope_epoch).not.toBe(revoked.scope_epoch);
    expect(leaving.effects).toEqual([{ kind: "logout" }]);
    actor.send({
      type: "source",
      state: {
        ...source,
        account_id: null,
        account: { status: "idle" },
        homes: { selectedHomeId: null, status: "unselected", items: [] },
      },
    });
    const unbound = expectLifecycle(actor, "unbound");
    expect(unbound.scope_epoch).not.toBe(leaving.scope_epoch);
    expect(unbound.projection.household.household.account_id).toBe(
      source.account_id,
    );
    expect(unbound.projection.household.household.home_id).toBe("home-a");
    expect(unbound.projection.device).toEqual({});
  });

  test("generic publish cannot choose a lifecycle and stale or stopped inputs do not commit", () => {
    const { actor, source } = running();
    const original = actor.getSnapshot().context;
    actor.send({
      type: "publish",
      scope_epoch: original.scope_epoch,
      projection: {
        ...original.projection,
        household: {
          household: {
            ...original.projection.household.household,
            status: "unbound",
          },
        },
      },
    });
    const unchanged = expectLifecycle(actor, "running");
    expect(unchanged.sequence).toBe(original.sequence);
    expect(unchanged.projection).toBe(original.projection);
    actor.send({
      type: "command",
      scope_epoch: crypto.randomUUID(),
      effect: { kind: "logout" },
    });
    actor.send({ type: "finished", operation_id: 99, operation: "logout" });
    const ignored = actor.getSnapshot().context;
    expect(ignored).toEqual(unchanged);
    expect(ignored.projection).toBe(unchanged.projection);
    actor.send({ type: "stop" });
    const stopped = expectLifecycle(actor, "stopping");
    expect(stopped.effects).toEqual([{ kind: "reset" }]);
    for (const event of [
      { type: "source", state: source },
      {
        type: "publish",
        scope_epoch: stopped.scope_epoch,
        projection: original.projection,
      },
      {
        type: "command",
        scope_epoch: stopped.scope_epoch,
        effect: { kind: "logout" },
      },
      { type: "stop" },
    ] as const)
      actor.send(event);
    expect(actor.getSnapshot().context).toBe(stopped);
    expectLifecycle(actor, "stopping");
  });
});

describe("household input ownership and atomic commits", () => {
  test("checking and sending a source event leave its input independently mutable", () => {
    const actor = start();
    const event = {
      type: "source" as const,
      state: structuredClone(machineSource()),
    };
    const original = structuredClone(event);
    const before = actor.getSnapshot();

    expect(before.can(event)).toBe(true);
    expect(actor.getSnapshot()).toBe(before);
    expect(event).toEqual(original);
    for (const value of [
      event.state.account,
      event.state.login,
      event.state.media,
      event.state.media.binding,
      event.state.homes.items,
    ])
      expect(Object.isFrozen(value)).toBe(false);

    actor.send(event);
    const committed = expectLifecycle(actor, "initializing");
    expect(event).toEqual(original);
    event.state.account.id = crypto.randomUUID();
    event.state.login.material_version++;
    event.state.media.revision = crypto.randomUUID();
    event.state.homes.items[0]!.name = "Changed after sending";

    expect(committed.projection.account.account).toEqual(
      original.state.account,
    );
    expect(committed.projection.login.login).toEqual(original.state.login);
    expect(committed.projection.media.media).toEqual(original.state.media);
    expect(Object.isFrozen(committed.projection.account.account)).toBe(true);
    expect(Object.isFrozen(committed.projection.media.media.binding)).toBe(
      true,
    );
  });

  test.each(["accepted", "rejected"] as const)(
    "prepares a directory once and publishes only its final %s result",
    (outcome) => {
      const oversized = outcome === "rejected";
      const actor = start();
      const source = structuredClone(machineSource());
      actor.send({ type: "source", state: source });
      const before = actor.getSnapshot();
      const directory = machineDirectory();
      const device = Object.values(directory.device)[0]!;
      if (oversized)
        device.name = "x".repeat(householdLimits.directoryBytes + 1);
      const event = {
        type: "directory" as const,
        scope_epoch: before.context.scope_epoch,
        projection: {
          ...before.context.projection,
          ...directory,
          household: {
            household: {
              ...before.context.projection.household.household,
              homes: source.homes,
            },
          },
        },
      };
      const original = structuredClone(directory);
      const snapshots: ReturnType<typeof actor.getSnapshot>[] = [];
      const subscription = actor.subscribe((snapshot) => {
        snapshots.push(snapshot);
      });
      const parse = spyOn(upsertChangeSchema, "parse");
      try {
        expect(before.can(event)).toBe(true);
        expect(parse).not.toHaveBeenCalled();
        expect(directory).toEqual(original);
        expect(Object.isFrozen(device)).toBe(false);
        expect(Object.isFrozen(device.channels)).toBe(false);
        expect(snapshots).toHaveLength(0);

        actor.send(event);
        const after = actor.getSnapshot();
        const validations = parse.mock.calls.filter(
          ([input]) =>
            input !== null &&
            typeof input === "object" &&
            "entity" in input &&
            input.entity === "device" &&
            "value" in input &&
            input.value === device,
        );
        expect(validations).toHaveLength(oversized ? 0 : 1);
        expect(snapshots).toEqual([after]);
        expect(after.context.input_sequence).toBe(
          before.context.input_sequence + 1,
        );
        expect(after.context.accepted).toBe(!oversized);
        expectLifecycle(actor, oversized ? "initializing" : "running");
        expect(directory).toEqual(original);
        expect(Object.isFrozen(device)).toBe(false);
        expect(Object.isFrozen(device.channels)).toBe(false);
        device.name = "Changed after sending";
        device.channels.push(1);
        if (oversized) {
          expect(after.context.projection.device).toBe(
            before.context.projection.device,
          );
          expect(after.context.effects).toEqual([]);
        } else {
          expect(after.context.projection.device).toEqual(original.device);
          expect(Object.isFrozen(after.context.projection.device)).toBe(true);
        }
      } finally {
        parse.mockRestore();
        subscription.unsubscribe();
      }
    },
  );
});

describe("capacity gates data without blocking lifecycle control", () => {
  test.each(["restore", "directory"] as const)(
    "rejects oversized %s without entering its target state",
    (kind) => {
      const actor = start();
      const source = machineSource();
      if (kind === "directory") actor.send({ type: "source", state: source });
      const before = actor.getSnapshot();
      const directory = machineDirectory();
      const home = Object.values(directory.home)[0]!;
      home.name = "x".repeat(householdLimits.directoryBytes + 1);
      if (kind === "restore") {
        actor.send({
          type: "restore",
          scope_epoch: before.context.scope_epoch,
          provider: source.provider,
          account_id: source.account_id,
          home_id: "home-a",
          directory,
          saved_at: null,
        });
      } else {
        actor.send({
          type: "directory",
          scope_epoch: before.context.scope_epoch,
          projection: {
            ...before.context.projection,
            ...directory,
            household: {
              household: {
                ...before.context.projection.household.household,
                homes: source.homes,
              },
            },
          },
        });
      }
      const after = actor.getSnapshot();
      expect(after.context.scope_epoch).toBe(before.context.scope_epoch);
      expect(after.context.projection.device).toEqual({});
      expect(after.context.effects).toEqual([]);
      if (kind === "restore") {
        expectLifecycle(actor, "initializing");
        expect(after.context.projection.household.household.home_id).toBe(
          "home-a",
        );
      } else {
        expect(after.context.accepted).toBe(false);
        expect(
          after.context.projection.projection_health.projection_health
            .capacity_degraded,
        ).toBe(true);
      }
    },
  );

  test("logout still clears running data after a directory admission failure", () => {
    const { actor } = running();
    const before = actor.getSnapshot().context;
    const directory = machineDirectory();
    Object.values(directory.device)[0]!.name = "x".repeat(
      householdLimits.directoryBytes + 1,
    );
    actor.send({
      type: "directory",
      scope_epoch: before.scope_epoch,
      projection: { ...before.projection, ...directory },
    });
    actor.send({
      type: "command",
      scope_epoch: before.scope_epoch,
      effect: { kind: "logout" },
    });
    const after = expectLifecycle(actor, "initializing");
    expect(after.scope_epoch).not.toBe(before.scope_epoch);
    expect(after.effects).toEqual([{ kind: "logout" }]);
    expect(after.projection.device).toEqual({});
    expect(after.projection.household.household.home_id).toBe("home-a");
  });
});
