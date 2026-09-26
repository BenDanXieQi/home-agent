import { HouseholdRuntime } from "../household/runtime";
import type { HouseholdRepository } from "../household/repository";
import { MiotSpecClient } from "./protocols/spec/client";
import { householdLimits } from "../household/config";
import { isRecoverableMijiaError, safeMijiaError } from "./errors";
import type { MijiaService } from "./service";

export function createMijiaSpecificationLoader() {
  const client = new MiotSpecClient(householdLimits.directoryBytes);
  return {
    async resolve(
      device: { model: string; spec_type: string | null },
      signal: AbortSignal,
    ) {
      const resolved = await client.resolve(
        {
          model: device.model,
          ...(device.spec_type ? { spec_type: device.spec_type } : {}),
        },
        signal,
      );
      return {
        urn: resolved.urn,
        read: (readSignal: AbortSignal) => client.read(resolved, readSignal),
      };
    },
    failure(error: unknown) {
      return {
        error: safeMijiaError(error, "spec_failed").toPayload(),
        retryable: isRecoverableMijiaError(error),
      };
    },
  };
}

/** Compose integration resources with the independent household application. */
export function createMijiaHousehold(
  service: MijiaService,
  repository: HouseholdRepository | undefined,
) {
  const runtime = new HouseholdRuntime(
    {
      snapshot: () => {
        const state = service.sourceSnapshot();
        return {
          provider: "mijia",
          account_id: state.accountId,
          account: state.account,
          login: state.login,
          connection: state.connectionOperation,
          media: { revision: state.revision, binding: state.binding },
          homes: state.homes,
          directory_sync:
            state.directory.status === "error"
              ? ("error" as const)
              : state.directory.status === "loading"
                ? ("syncing" as const)
                : state.directory.status === "ready"
                  ? ("synced" as const)
                  : ("unsynced" as const),
          directory_error:
            state.directory.status === "error" ? state.directory.error : null,
          directory_capacity:
            state.directory.status === "error" &&
            state.directory.error.code === "mijia_capacity_exceeded",
          directory_storage:
            state.directory.status === "error" &&
            ["mijia_home_storage", "mijia_home_storage_unconfirmed"].includes(
              state.directory.error.code,
            ),
        };
      },
      subscribe: (listener) => service.subscribe(listener),
      validateHome: (id) => service.validateHome(id),
      selectHome: (id, assert) => service.selectHome(id, assert),
      refreshDirectory: () => service.loadDevices(),
      logout: () => service.logout(),
      close: () => service.close(),
      reservePlayback: (revision, id, channel) =>
        service.reservePlayback(revision, id, channel),
      failure: (error, stage) =>
        safeMijiaError(
          error,
          stage === "account" ? "home_storage" : "devices_failed",
        ).toPayload(),
    },
    repository,
    createMijiaSpecificationLoader(),
  );
  service.attachHousehold({
    restore: (account, home) => runtime.restore(account, home),
    commit: (candidate, assert) => runtime.commitDirectory(candidate, assert),
    revoke: (candidate, assert) => runtime.revoke(candidate, assert),
    ready: () => runtime.ready,
    specification: (id) => runtime.specification(id),
  });
  return runtime;
}
