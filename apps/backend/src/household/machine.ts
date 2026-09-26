import { assign, enqueueActions, setup } from "xstate";
import { produce } from "@home-agent/api/immutable";
import type {
  DirectoryRefreshTarget,
  Projection,
} from "@home-agent/api/household";
import { householdLimits, jsonBytes } from "./config";
import { initialProjection } from "./projection";
import {
  initialProjectionState,
  prepareProjection,
  directoryFits,
} from "./capacity";
import type { HouseholdSourceState } from "./source";

type Effect =
  | { kind: "refresh"; target: DirectoryRefreshTarget }
  | { kind: "logout" }
  | { kind: "reset" };
type Household = Projection["household"]["household"];
type Input =
  | { type: "publish"; scope_epoch: string; projection: Projection }
  | { type: "source"; state: HouseholdSourceState }
  | {
      type: "restore";
      scope_epoch: string;
      provider: string;
      account_id: string;
      home_id: string | null;
      directory: Pick<Projection, "home" | "room" | "device">;
      saved_at: string | null;
    }
  | { type: "directory"; scope_epoch: string; projection: Projection }
  | {
      type: "revoke";
      scope_epoch: string;
      projection: Projection;
      homeLost: boolean;
    }
  | {
      type: "command";
      scope_epoch: string;
      effect: Exclude<Effect, { kind: "reset" }>;
    }
  | { type: "finished"; operation_id: number; operation: "logout" }
  | { type: "bound"; scope_epoch: string; home_id: string }
  | {
      type: "failure";
      scope_epoch: string;
      stage: "account" | "directory";
      error: NonNullable<Household["error"]>;
    }
  | { type: "stop" };

function initialContext() {
  return {
    ...initialProjectionState(initialProjection()),
    scope_epoch: crypto.randomUUID(),
    sequence: 0,
    input_sequence: 0,
    operation: null as "logout" | null,
    operation_id: null as number | null,
    accountInstance: null as string | null,
    cached: false,
    accepted: true,
    effects: [] as Effect[],
    changes: [] as ReturnType<typeof prepareProjection>["changes"],
  };
}
function clearRuntime(draft: Projection) {
  draft.home = {};
  draft.room = {};
  draft.device = {};
}
function updateHousehold(projection: Projection, values: Partial<Household>) {
  return produce(projection, (draft) => {
    Object.assign(draft.household.household, values);
  });
}
function prepareCommit(
  context: ReturnType<typeof initialContext>,
  projection: Projection,
  options: {
    newScope?: boolean;
    operation?: ReturnType<typeof initialContext>["operation"];
    operation_id?: number | null;
    cached?: boolean;
    accountInstance?: string | null;
    effects?: Effect[];
  } = {},
  lifecycle?: Household["status"],
) {
  // Only the selected statechart transition can change the public lifecycle.
  const output = updateHousehold(projection, {
    status: lifecycle ?? context.projection.household.household.status,
  });
  return {
    prepared: prepareProjection(context, output),
    accepted: true,
    options,
  };
}
function commit(
  context: ReturnType<typeof initialContext>,
  { prepared, accepted, options }: ReturnType<typeof prepareCommit>,
) {
  return {
    ...context,
    ...prepared,
    accepted,
    input_sequence: context.input_sequence + 1,
    scope_epoch:
      accepted && options.newScope ? crypto.randomUUID() : context.scope_epoch,
    sequence:
      accepted && options.newScope
        ? 0
        : context.sequence + Number(prepared.changes.length > 0),
    operation:
      accepted && options.operation !== undefined
        ? options.operation
        : context.operation,
    operation_id: accepted
      ? options.operation_id !== undefined
        ? options.operation_id
        : options.operation === null
          ? null
          : context.operation_id
      : context.operation_id,
    cached:
      accepted && options.cached !== undefined
        ? options.cached
        : context.cached,
    accountInstance:
      accepted && options.accountInstance !== undefined
        ? options.accountInstance
        : context.accountInstance,
    effects: accepted ? (options.effects ?? []) : [],
  };
}
function sourceIdentity(
  context: ReturnType<typeof initialContext>,
  source: HouseholdSourceState,
) {
  const before = context.projection.household.household;
  const instance =
    source.account.status === "authenticated" ? source.account.id : null;
  const accountInstance =
    instance !== null ||
    source.account.status === "idle" ||
    source.account.status === "reauth_required"
      ? instance
      : context.accountInstance;
  const replaced =
    instance !== null &&
    context.accountInstance !== null &&
    instance !== context.accountInstance;
  const changed =
    replaced ||
    (instance !== null &&
      context.projection.account.account.status !== "authenticated" &&
      !context.cached) ||
    (source.account_id !== null &&
      (source.account_id !== before.account_id ||
        source.provider !== before.provider)) ||
    (source.account_id === null &&
      (source.account.status === "idle" ||
        source.account.status === "reauth_required") &&
      context.accountInstance !== null);
  return { changed, accountInstance };
}
function sourceChanged(
  context: ReturnType<typeof initialContext>,
  source: HouseholdSourceState,
  lifecycle?: Household["status"],
) {
  const { changed, accountInstance } = sourceIdentity(context, source);
  const operation =
    changed && !(context.operation === "logout" && source.account_id !== null)
      ? null
      : context.operation;
  const projection = produce(context.projection, (draft) => {
    draft.account.account = source.account;
    if (
      source.account.status === "authenticated" &&
      jsonBytes(source.account.profile) > householdLimits.metadataBytes
    ) {
      const previous = context.projection.account.account;
      draft.account.account = {
        ...source.account,
        profile:
          !changed && previous.status === "authenticated"
            ? previous.profile
            : null,
      };
      draft.projection_health.projection_health.capacity_degraded = true;
    }
    draft.login.login = source.login;
    draft.connection.connection = source.connection;
    draft.media.media = source.media;
    const household = draft.household.household;
    if (changed) {
      clearRuntime(draft);
      Object.assign(household, {
        provider:
          household.home_id === null
            ? source.account_id
              ? source.provider
              : null
            : household.provider,
        account_id:
          household.home_id === null ? source.account_id : household.account_id,
        home_id: household.home_id ?? source.homes.selectedHomeId,
        homes: {
          selectedHomeId: household.home_id ?? source.homes.selectedHomeId,
          status: source.homes.status,
        },
        stage: "account",
        sync_status: "unsynced",
        cloud_synced_at: null,
        saved_at: null,
        error: null,
      } satisfies Partial<Household>);
    } else if (!operation && !context.cached) {
      household.homes = {
        selectedHomeId: household.home_id,
        status: source.homes.status,
      };
    }
    if (
      source.account.status === "restore_error" ||
      source.account.status === "reauth_required"
    ) {
      household.error = source.account.error;
      household.sync_status = "error";
    }
    if (source.directory_error) {
      household.error = source.directory_error;
      household.sync_status = "error";
    } else if (
      source.directory_sync === "syncing" &&
      household.sync_status !== "error"
    ) {
      household.sync_status = "syncing";
    }
    const health = draft.projection_health.projection_health;
    if (source.directory_capacity) health.capacity_degraded = true;
    if (source.directory_storage) health.storage_degraded = true;
  });
  const candidate = prepareCommit(
    context,
    projection,
    {
      newScope: changed,
      operation,
      accountInstance,
      cached: changed ? false : context.cached,
      effects: changed ? [{ kind: "reset" }] : [],
    },
    lifecycle,
  );
  return candidate;
}
/** Prepare one input before the internal commit chooses a lifecycle target. */
function prepareInput(
  context: ReturnType<typeof initialContext>,
  event: Input,
  lifecycle?: Household["status"],
) {
  if ("scope_epoch" in event && event.scope_epoch !== context.scope_epoch)
    return undefined;
  switch (event.type) {
    case "source":
      return sourceChanged(context, event.state, lifecycle);
    case "stop":
      return prepareCommit(
        context,
        context.projection,
        {
          operation: null,
          effects: [{ kind: "reset" }],
        },
        lifecycle,
      );
    case "finished":
      if (
        context.operation !== event.operation ||
        context.operation_id !== event.operation_id
      )
        return undefined;
      return prepareCommit(context, context.projection, { operation: null });
    case "bound":
      if (context.projection.household.household.home_id !== null)
        return undefined;
      return prepareCommit(
        context,
        updateHousehold(context.projection, {
          home_id: event.home_id,
          homes: { selectedHomeId: event.home_id, status: "selected" },
          stage: "directory",
          sync_status: "syncing",
          error: null,
        }),
        {},
        lifecycle,
      );
    case "failure":
      return prepareCommit(
        context,
        updateHousehold(context.projection, {
          stage: event.stage,
          error: event.error,
          sync_status: "error",
        }),
      );
    case "command": {
      const effect = event.effect;
      if (
        effect.kind !== "logout" &&
        (context.projection.account.account.status !== "authenticated" ||
          context.operation === "logout")
      )
        return undefined;
      if (effect.kind === "refresh") {
        return prepareCommit(context, context.projection, {
          effects: [effect],
        });
      }
      const projection = produce(context.projection, (draft) => {
        clearRuntime(draft);
        const household = draft.household.household;
        household.stage = "account";
        household.sync_status = "unsynced";
        household.error = null;
        household.saved_at = null;
        household.cloud_synced_at = null;
      });
      return prepareCommit(
        context,
        projection,
        {
          newScope: true,
          cached: false,
          operation: effect.kind,
          operation_id: context.input_sequence + 1,
          effects: [effect],
        },
        lifecycle,
      );
    }
    case "restore": {
      const homes = {
        selectedHomeId: event.home_id,
        status: event.home_id ? ("selected" as const) : ("unselected" as const),
      };
      const directory = directoryFits(event.directory)
        ? event.directory
        : { home: {}, room: {}, device: {} };
      return prepareCommit(
        context,
        updateHousehold(
          { ...context.projection, ...directory },
          {
            provider: event.provider,
            account_id: event.account_id,
            home_id: event.home_id,
            homes,
            stage: "account",
            sync_status: "unsynced",
            saved_at: event.saved_at,
          },
        ),
        { cached: true },
        lifecycle,
      );
    }
    case "directory": {
      const { home, room, device } = event.projection;
      if (!directoryFits({ home, room, device }))
        return {
          ...prepareCommit(
            context,
            produce(context.projection, (draft) => {
              draft.projection_health.projection_health.capacity_degraded = true;
            }),
          ),
          accepted: false,
        };
      return prepareCommit(
        context,
        updateHousehold(event.projection, {
          stage:
            event.projection.household.household.homes.status === "unavailable"
              ? "directory"
              : "ready",
          sync_status:
            event.projection.household.household.homes.status === "unavailable"
              ? "error"
              : "synced",
          error: event.projection.household.household.error,
        }),
        { cached: false },
        lifecycle,
      );
    }
    case "revoke":
      // The runtime derives this candidate only by removing already accepted data.
      return prepareCommit(
        context,
        event.projection,
        {
          newScope: event.homeLost,
          operation: event.homeLost ? null : context.operation,
          cached: false,
          effects: event.homeLost ? [{ kind: "reset" }] : [],
        },
        lifecycle,
      );
    case "publish":
      return prepareCommit(context, event.projection);
  }
  return event satisfies never;
}

type MachineEvent =
  | Input
  | {
      type: "commit";
      prepared: ReturnType<typeof prepareCommit>;
      lifecycle: Household["status"] | undefined;
    };
type TransitionInput = {
  context: ReturnType<typeof initialContext>;
  event: MachineEvent;
};

function prepareTransition(
  lifecycle: Household["status"],
  accepts: (input: TransitionInput) => boolean,
) {
  return {
    guard: (input: TransitionInput) =>
      accepts(input) &&
      (!("scope_epoch" in input.event) ||
        input.event.scope_epoch === input.context.scope_epoch),
    actions: { type: "prepare" as const, params: { lifecycle } },
  };
}

/** Internal events finish within the same macrostep, before publishing a snapshot. */
function commitTransition(lifecycle: Household["status"]) {
  return {
    target: `#household.${lifecycle}`,
    guard: ({ event }: TransitionInput) =>
      event.type === "commit" &&
      event.prepared.accepted &&
      event.lifecycle === lifecycle,
    actions: "commit" as const,
  };
}
const updateState = { actions: { type: "prepare" as const, params: {} } };
const commands = [
  prepareTransition(
    "initializing",
    ({ event }) => event.type === "command" && event.effect.kind !== "refresh",
  ),
  updateState,
];
const restore = prepareTransition(
  "initializing",
  ({ event }) => event.type === "restore",
);
const directory = [
  prepareTransition(
    "running",
    ({ event, context }) =>
      event.type === "directory" &&
      context.projection.account.account.status === "authenticated" &&
      event.projection.household.household.homes.status === "selected",
  ),
  prepareTransition(
    "waiting_for_home",
    ({ event, context }) =>
      event.type === "directory" &&
      context.projection.account.account.status === "authenticated" &&
      event.projection.household.household.home_id === null,
  ),
  prepareTransition(
    "initializing",
    ({ event, context }) =>
      event.type === "directory" &&
      context.projection.account.account.status === "authenticated",
  ),
];
const revocations = [
  prepareTransition(
    "initializing",
    ({ event }) => event.type === "revoke" && event.homeLost,
  ),
  updateState,
];

/** Statechart transitions own lifecycle; the projection only publishes their result. */
export const householdMachine = setup({
  types: {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    context: {} as ReturnType<typeof initialContext>,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    events: {} as MachineEvent,
  },
  actions: {
    prepare: enqueueActions(
      (
        { context, event, enqueue },
        params: { lifecycle?: Household["status"] },
      ) => {
        if (event.type === "commit") return;
        const prepared = prepareInput(context, event, params.lifecycle);
        if (prepared)
          enqueue.raise({
            type: "commit",
            prepared,
            lifecycle: params.lifecycle,
          });
      },
    ),
    commit: assign(({ context, event }) =>
      event.type === "commit" ? commit(context, event.prepared) : context,
    ),
  },
}).createMachine({
  id: "household",
  context: initialContext,
  initial: "unbound",
  on: {
    commit: [
      commitTransition("unbound"),
      commitTransition("waiting_for_home"),
      commitTransition("initializing"),
      commitTransition("running"),
      commitTransition("stopping"),
      { actions: "commit" },
    ],
    source: [
      prepareTransition(
        "unbound",
        ({ event }) =>
          event.type === "source" &&
          event.state.account_id === null &&
          (event.state.account.status === "idle" ||
            event.state.account.status === "reauth_required"),
      ),
      prepareTransition(
        "initializing",
        ({ context, event }) =>
          event.type === "source" &&
          event.state.account_id !== null &&
          sourceIdentity(context, event.state).changed,
      ),
      updateState,
    ],
    publish: updateState,
    failure: updateState,
    finished: updateState,
    bound: prepareTransition(
      "initializing",
      ({ event, context }) =>
        event.type === "bound" &&
        context.projection.household.household.home_id === null,
    ),
    stop: prepareTransition("stopping", () => true),
  },
  states: {
    unbound: {
      on: {
        restore,
        command: prepareTransition(
          "initializing",
          ({ event }) =>
            event.type === "command" && event.effect.kind === "logout",
        ),
      },
    },
    waiting_for_home: {
      on: { command: commands, directory, revoke: revocations },
    },
    initializing: {
      on: { command: commands, directory, revoke: revocations, restore },
    },
    running: { on: { command: commands, directory, revoke: revocations } },
    stopping: { on: { "*": {} } },
  },
});
