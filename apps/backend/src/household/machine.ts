import { setup, assign } from "xstate";
import type {
  DirectoryRefreshTarget,
  Projection,
} from "@home-agent/api/household";
import { initialProjection, projectionChanges } from "./projection";
import { householdLimits, jsonBytes } from "./config";

type Effect =
  | { kind: "select"; home_id: string | null }
  | { kind: "refresh"; target: DirectoryRefreshTarget };
type Input =
  | {
      type: "publish";
      scope_epoch: string;
      projection: Projection;
      newScope?: boolean;
    }
  | { type: "command"; scope_epoch: string; effect: Effect }
  | { type: "stop" };
function initialContext() {
  return {
    scope_epoch: crypto.randomUUID(),
    sequence: 0,
    projection: initialProjection(),
    input_sequence: 0,
    effects: [] as Effect[],
    changes: [] as ReturnType<typeof projectionChanges>,
  };
}
function transition(context: ReturnType<typeof initialContext>, event: Input) {
  if (event.type === "stop") {
    const projection = {
      ...context.projection,
      household: {
        household: {
          ...context.projection.household.household,
          status: "stopping" as const,
        },
      },
    };
    return {
      ...context,
      input_sequence: context.input_sequence + 1,
      effects: [],
      sequence: context.sequence + 1,
      projection,
      changes: projectionChanges(context.projection, projection),
    };
  }
  if (
    context.projection.household.household.status === "stopping" ||
    event.scope_epoch !== context.scope_epoch
  )
    return context;
  if (event.type === "command") {
    const projection =
      event.effect.kind === "select"
        ? {
            ...context.projection,
            home: {},
            room: {},
            device: {},
            spec: {},
            latest: {},
            source_health: {},
            rule_status: {},
            household: {
              household: {
                ...context.projection.household.household,
                home_id: event.effect.home_id,
                homes: {
                  ...context.projection.household.household.homes,
                  selectedHomeId: event.effect.home_id,
                },
                status: "initializing" as const,
                stage: "selection" as const,
                sync_status: "unsynced" as const,
                error: null,
                saved_at: null,
                cloud_synced_at: null,
              },
            },
          }
        : context.projection;
    return {
      ...context,
      scope_epoch:
        event.effect.kind === "select"
          ? crypto.randomUUID()
          : context.scope_epoch,
      sequence: event.effect.kind === "select" ? 0 : context.sequence,
      projection,
      input_sequence: context.input_sequence + 1,
      effects: [event.effect],
      changes: [],
    };
  }
  let projection = event.projection;
  const { home, room, device, spec, latest, ...metadata } = projection;
  if (
    jsonBytes({ home, room, device, spec }) > householdLimits.directoryBytes ||
    jsonBytes(metadata) > householdLimits.metadataBytes - 1024 ||
    jsonBytes(latest) > householdLimits.changesBytes ||
    jsonBytes(projection) > householdLimits.snapshotBytes - 1024
  ) {
    projection = {
      ...context.projection,
      projection_health: {
        projection_health: {
          ...context.projection.projection_health.projection_health,
          capacity_degraded: true,
        },
      },
    };
  }
  const changes = projectionChanges(context.projection, projection);
  return {
    ...context,
    projection,
    scope_epoch: event.newScope ? crypto.randomUUID() : context.scope_epoch,
    sequence: event.newScope
      ? 0
      : context.sequence + Number(changes.length > 0),
    input_sequence: context.input_sequence + 1,
    effects: [],
    changes,
  };
}
export const householdMachine = setup({
  // XState declares event/context input boundaries through its setup types.
  types: {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    context: {} as ReturnType<typeof initialContext>,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    events: {} as Input,
  },
  actions: {
    commit: assign(({ context, event }) => transition(context, event)),
  },
}).createMachine({
  id: "household",
  context: initialContext,
  initial: "unbound",
  on: {
    publish: { actions: "commit" },
    command: { actions: "commit" },
    stop: { actions: "commit" },
  },
  states: {
    unbound: {
      always: [
        {
          guard: ({ context }) =>
            context.projection.household.household.status ===
            "waiting_for_home",
          target: "waiting_for_home",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "initializing",
          target: "initializing",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "running",
          target: "running",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "stopping",
          target: "stopping",
        },
      ],
    },
    waiting_for_home: {
      always: [
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "unbound",
          target: "unbound",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "initializing",
          target: "initializing",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "running",
          target: "running",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "stopping",
          target: "stopping",
        },
      ],
    },
    initializing: {
      always: [
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "unbound",
          target: "unbound",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status ===
            "waiting_for_home",
          target: "waiting_for_home",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "running",
          target: "running",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "stopping",
          target: "stopping",
        },
      ],
    },
    running: {
      always: [
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "unbound",
          target: "unbound",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status ===
            "waiting_for_home",
          target: "waiting_for_home",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "initializing",
          target: "initializing",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "stopping",
          target: "stopping",
        },
      ],
    },
    stopping: {
      always: [
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "unbound",
          target: "unbound",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status ===
            "waiting_for_home",
          target: "waiting_for_home",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "initializing",
          target: "initializing",
        },
        {
          guard: ({ context }) =>
            context.projection.household.household.status === "running",
          target: "running",
        },
      ],
    },
  },
});
