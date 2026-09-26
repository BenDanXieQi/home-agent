import { DirectoryNotifications } from "./devices/directory-notifications";
import { AccountObservations } from "./account/observations";
import type { MiotObservation } from "./protocols/miot/messages";
import { miotPushSourceId } from "./properties/source-profiles";
import { authorizeOAuth } from "./protocols/oauth/client";
import {
  AccountMaintenance,
  type AccountSessionCandidate,
} from "./account/maintenance";
import { LoginFlow, type LoginCandidate } from "./account/login-flow";
import { miotSourceId } from "./properties/source-profiles";
import { preparePropertyRead } from "./properties/read-request";
import type { MiotPropertyAddress } from "./protocols/micloud/properties";
import { PropertyReader } from "./properties/reader";
import type { MiCloud } from "./protocols/micloud";
import type { Operation } from "@home-agent/api/contracts";
import type { MijiaState } from "@home-agent/api/mijia";
import type { CredentialStore } from "../credentials/store";
import { MediaSession } from "./media/session";
import { MijiaError, safeMijiaError } from "./errors";
import { DeviceDiscovery } from "./devices/discovery";
import type { MijiaDeviceSpec } from "@home-agent/api/mijia";
import { mijiaOperation } from "./operation";

import { accountSessionSchema } from "./account/session";
import { deviceDirectory } from "./devices/directory";
import type { HomeSelectionStore } from "./homes/store";

export type MijiaDependencies = {
  homeSelectionStore: HomeSelectionStore | undefined;
  readGo2rtcUrl: () => Promise<string>;
  credentialStore: CredentialStore | undefined;
};

/** Owns the durable account; only the current task may adopt credentials or media. */
export class MijiaService {
  private state: Pick<MijiaState, "account" | "connectionOperation"> = {
    connectionOperation: null,
    account: { status: "idle" },
  };
  private accountClient: MiCloud | undefined;
  private chooseDefaultHome = true;
  private accountOAuth: AccountSessionCandidate["oauth"] | undefined;
  private readonly loginFlow = new LoginFlow(
    (candidate) => this.commitLogin(candidate),
    () => this.changed(),
  );
  private lifecycleQueue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  private initialRestorePending = false;
  private committingCredentials = false;
  private loggingOut = false;

  private readonly media: MediaSession;
  private readonly discovery: DeviceDiscovery;
  private readonly maintenance: AccountMaintenance;

  constructor({
    readGo2rtcUrl,
    credentialStore,
    homeSelectionStore,
  }: MijiaDependencies) {
    this.homeSelectionStore = homeSelectionStore;
    this.credentialStore = credentialStore;
    this.media = new MediaSession({
      readUrl: readGo2rtcUrl,
      onChange: () => this.changed(),
      currentAccount: () => this.accountClient,
      canBind: () => this.household?.ready() === true,
      acceptsWork: () => !this.stopped && !this.loggingOut,
      stopped: () => this.stopped,
      canReconfigure: () =>
        !this.stopped && !this.loggingOut && !this.committingCredentials,
      serial: (run) => this.serial(run),
    });
    this.discovery = new DeviceDiscovery({
      onChange: () => this.changed(),
      commit: (catalog, account, assertCurrent) =>
        this.serial(async () => {
          assertCurrent();
          await this.commitCatalog(catalog, account, assertCurrent);
        }),
      currentAccount: () => this.accountClient,
      activeAccount: (account) => this.activeAccount(account),
      stopped: () => this.stopped,
      renewalFailed: (account) => this.maintenance.renewalFailed(account),
      renew: (account) => this.maintenance.renew(account),
      onScopeChanged: () => {
        this.invalidateDeviceAccess();
        this.media.prepareRebind();
        if (this.household?.ready())
          void this.media.startBinding().catch(() => {});
      },
      onDevices: (devices, retryFailed) =>
        this.media.updateDevices(
          this.household?.ready() ? devices : [],
          retryFailed,
        ),
    });
    this.maintenance = new AccountMaintenance({
      currentAccount: () => this.accountClient,
      currentOAuth: () => this.accountOAuth,
      isActive: (account) => this.activeAccount(account),
      acceptsWork: () => !this.stopped && !this.loggingOut,
      committing: () => this.committingCredentials,
      isLoginActive: () => this.loginFlow.active,
      readStore: () => this.requireStore(),
      commitRestored: (candidate, assertCurrent) =>
        this.commitRestored(candidate, assertCurrent),
      commitRenewed: (account, candidate, assertCurrent) =>
        this.commitRenewed(account, candidate, assertCurrent),
      onRestoreState: (state) => {
        this.state.account = state;
        this.changed();
      },
      onRenewalFailure: async (account, failure) => {
        if (failure.reason === "authentication")
          await this.expireAccount(account, failure);
        else if (this.activeAccount(account)) this.discovery.fail(failure);
      },
    });
  }

  private readonly directoryNotifications = new DirectoryNotifications(() =>
    this.discovery.load(true),
  );
  private mqtt: AccountObservations | undefined;
  private observationScope = new AbortController();
  private mqttClosing: Promise<void> = Promise.resolve();
  private readScope = new AbortController();
  private readGeneration = crypto.randomUUID();
  private readonly propertyReader = new PropertyReader();
  private readonly credentialStore: CredentialStore | undefined;
  private readonly homeSelectionStore: HomeSelectionStore | undefined;
  private readonly listeners = new Set<() => void>();
  private notificationPending = false;
  private household:
    | {
        restore: (accountId: string, homeId: string | null) => Promise<void>;
        commit: (
          directory: ReturnType<typeof deviceDirectory>,
          assertCurrent: () => void,
        ) => Promise<() => void>;
        ready: () => boolean;
        specification: (id: string) => MijiaDeviceSpec;
      }
    | undefined;

  attachHousehold(household: NonNullable<MijiaService["household"]>) {
    this.household = household;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    if (this.notificationPending) return;
    this.notificationPending = true;
    queueMicrotask(() => {
      this.notificationPending = false;
      for (const listener of this.listeners) listener();
    });
  }
  flushChanges() {
    for (const listener of this.listeners) listener();
  }
  identity() {
    return this.accountClient ? this.accountKey(this.accountClient) : null;
  }
  directoryCandidate(
    catalog: Awaited<ReturnType<MiCloud["getCatalog"]>>,
    account: MiCloud,
  ) {
    return deviceDirectory(
      catalog,
      this.accountKey(account),
      this.discovery.homeSnapshot().selectedHomeId,
    );
  }

  directorySnapshot() {
    return this.accountClient
      ? this.directoryCandidate(
          this.discovery.catalogSnapshot(),
          this.accountClient,
        )
      : null;
  }
  private async commitCatalog(
    catalog: Awaited<ReturnType<MiCloud["getCatalog"]>>,
    account: MiCloud,
    assertCurrent: () => void,
  ) {
    assertCurrent();
    this.discovery.revoke(catalog);
    this.flushChanges();
    this.discovery.retain(catalog, account);
    if (
      this.chooseDefaultHome &&
      this.discovery.homeSnapshot().selectedHomeId === null &&
      catalog.homes.length === 1
    ) {
      await this.requireHomeStore().write(
        this.accountKey(account),
        catalog.homes[0]!.id,
        assertCurrent,
      );
      assertCurrent();
      this.discovery.acceptHome(catalog.homes[0]!.id);
    }
    this.chooseDefaultHome = false;
    if (!this.household) throw new MijiaError("invalid_state");
    const commit = await this.household.commit(
      this.directoryCandidate(catalog, account),
      assertCurrent,
    );
    assertCurrent();
    this.discovery.set(catalog, true);
    commit();
    this.syncDirectoryNotifications();
    this.media.updateDevices(
      this.household.ready() ? this.discovery.list() : [],
      true,
    );
    if (this.household.ready() && this.media.binding.status === "unbound")
      void this.media.startBinding().catch(() => {});
    this.changed();
  }
  loginMaterial(id: string) {
    return this.loginFlow.material(id);
  }
  loginPublic() {
    return this.loginFlow.publicSnapshot();
  }
  suspendHousehold() {
    this.invalidateDeviceAccess();
    this.discovery.suspend();
    this.media.revokeAccount();
    this.changed();
  }

  private requireHomeStore() {
    if (!this.homeSelectionStore) throw new MijiaError("home_storage");
    return this.homeSelectionStore;
  }
  private accountKey(account: MiCloud) {
    const { userId, region } = account.getCredentials();
    return JSON.stringify([region, userId]);
  }
  homes() {
    if (!this.accountClient) throw new MijiaError("not_bound");
    if (!this.activeAccount(this.accountClient))
      throw new MijiaError("stale_session");
    return this.discovery.homeSnapshot();
  }
  validateHome(homeId: string | null) {
    this.discovery.validateSelection(homeId);
  }
  async selectHome(homeId: string | null, assertCurrent: () => void) {
    const account = this.accountClient;
    if (!account || !this.activeAccount(account))
      throw new MijiaError("not_bound");
    this.chooseDefaultHome = false;
    await this.serial(async () => {
      if (!this.activeAccount(account)) throw new MijiaError("stale_session");
      assertCurrent();
      await this.requireHomeStore().write(
        this.accountKey(account),
        homeId,
        assertCurrent,
      );
      assertCurrent();
      if (!this.activeAccount(account)) throw new MijiaError("stale_session");
      this.discovery.acceptHome(homeId);
    });
    await this.loadDevices();
    if (this.activeAccount(account)) await this.media.startBinding();
  }

  private invalidateDeviceAccess() {
    this.directoryNotifications.close();
    const mqtt = this.mqtt;
    this.mqtt = undefined;
    if (mqtt)
      this.mqttClosing = Promise.all([
        this.mqttClosing,
        mqtt.close("scope_invalidated"),
      ]).then(() => {});
    this.observationScope.abort();
    this.observationScope = new AbortController();
    this.invalidatePropertyReads();
  }

  private invalidatePropertyReads() {
    this.readScope.abort();
    this.readScope = new AbortController();
    this.readGeneration = crypto.randomUUID();
  }

  private accountObservations(account: MiCloud) {
    const accountKey = this.accountKey(account);
    const scope = this.observationScope.signal;
    if (this.mqtt?.closed) this.mqtt = undefined;
    return (this.mqtt ??= new AccountObservations(
      miotPushSourceId(account.getCredentials().userId),
      () => {
        scope.throwIfAborted();
        if (
          !this.accountClient ||
          !this.activeAccount(this.accountClient) ||
          this.accountKey(this.accountClient) !== accountKey
        )
          throw new MijiaError("stale_session");
        if (!this.accountOAuth || this.accountOAuth.expiresAt <= Date.now())
          throw new MijiaError("authentication");
        return this.accountOAuth;
      },
      () => {
        const current = this.accountClient;
        if (
          current &&
          this.activeAccount(current) &&
          this.accountKey(current) === accountKey &&
          this.observationScope.signal === scope
        )
          void this.maintenance.rejectOAuth(current);
      },
      () => {
        const current = this.accountClient;
        if (
          current &&
          this.activeAccount(current) &&
          this.accountKey(current) === accountKey &&
          this.observationScope.signal === scope
        ) {
          // A topic ACL refusal can revoke device access without invalidating the token.
          void this.discovery.load(true).catch(() => {});
        }
      },
    ));
  }
  private syncDirectoryNotifications() {
    const account = this.accountClient;
    if (!account || !this.activeAccount(account) || !this.accountOAuth) return;
    const scope = this.observationScope.signal;
    void this.mqttClosing.then(() => {
      if (scope.aborted || !this.activeAccount(account)) return;
      this.directoryNotifications.update(
        this.accountObservations(account),
        account.getCredentials().userId,
        this.discovery.catalogSnapshot().devices.map((device) => device.did),
      );
    });
  }
  directoryPushStatus() {
    return this.directoryNotifications.snapshot();
  }

  async observeDevices(
    deviceIds: readonly string[],
    onObservation: (observation: MiotObservation) => void,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (!this.household?.ready()) throw new MijiaError("devices_failed");
    const account = this.accountClient;
    if (!account || !this.accountOAuth) throw new MijiaError("not_bound");
    const ids = [...new Set(deviceIds)];
    if (!ids.length) throw new MijiaError("invalid_input");
    const scope = this.observationScope.signal;
    const revision = this.discovery.revision;
    const combined = AbortSignal.any([signal, scope]);
    const assertCurrent = () => {
      combined.throwIfAborted();
      if (
        !this.accountClient ||
        !this.activeAccount(this.accountClient) ||
        this.observationScope.signal !== scope ||
        this.discovery.revision !== revision
      )
        throw new MijiaError("stale_session");
    };
    // Membership is checked on admission. Revoking membership/model/spec changes
    // the scope revision and aborts its observers, so delivery needs no catalog scan.
    const assertDevices = () => {
      assertCurrent();
      this.discovery.requireHome();
      if (!this.discovery.catalogConfirmed)
        throw new MijiaError("devices_failed");
      if (ids.some((id) => !this.discovery.find(id)))
        throw new MijiaError("device_not_found");
    };
    assertDevices();
    return this.serial(async () => {
      await this.mqttClosing;
      assertDevices();
      if (this.mqtt?.closed) {
        await this.mqtt.close();
        this.mqtt = undefined;
      }
      assertDevices();
      // A renewal can replace the account while this operation is queued.
      if (!this.accountOAuth || this.accountOAuth.expiresAt <= Date.now())
        throw new MijiaError("authentication");
      const mqtt = this.accountObservations(account);
      const observation = mqtt.observe(
        ids,
        (event) => {
          // Scope-invalidated control events are allowed to explain lost coverage;
          // data and confirmations must still belong to the active account/scope.
          if (
            (event.kind === "connection" && event.status === "closed") ||
            (event.kind === "subscription" && event.status === "cancelled")
          ) {
            if (!signal.aborted) onObservation(event);
            return;
          }
          try {
            assertCurrent();
          } catch {
            return;
          }
          onObservation(event);
        },
        combined,
      );
      return {
        ...observation,
        retry: () => {
          assertCurrent();
          observation.retry();
        },
      };
    });
  }

  async readProperties(
    properties: readonly MiotPropertyAddress[],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (!this.household?.ready()) throw new MijiaError("devices_failed");
    const client = this.accountClient;
    if (!client) throw new MijiaError("not_bound");
    if (!this.activeAccount(client)) throw new MijiaError("stale_session");
    const uid = client.getCredentials().userId;
    const generation = this.readGeneration;
    this.discovery.requireHome();
    if (!this.discovery.catalogConfirmed)
      throw new MijiaError("devices_failed");
    const combined = AbortSignal.any([signal, this.readScope.signal]);
    const propertiesSnapshot = properties.map((property) => ({ ...property }));
    const devices = new Map(
      [...new Set(propertiesSnapshot.map(({ did }) => did))].map((did) => [
        did,
        this.discovery.find(did),
      ]),
    );
    const assertCurrent = () => {
      combined.throwIfAborted();
      if (!this.activeAccount(client) || this.readGeneration !== generation)
        throw new MijiaError("stale_session");
      if (!this.discovery.catalogConfirmed)
        throw new MijiaError("devices_failed");
      for (const [did, previous] of devices) {
        const current = this.discovery.find(did);
        if (!previous || !current) throw new MijiaError("device_not_found");
        if (
          previous.home_id !== current.home_id ||
          previous.model !== current.model ||
          previous.spec_type !== current.spec_type
        )
          throw new MijiaError("stale_session");
      }
    };
    assertCurrent();
    const requested = preparePropertyRead(
      propertiesSnapshot,
      {
        getDeviceSpec: (did, readSignal) => this.getDeviceSpec(did, readSignal),
        assertCurrent,
      },
      combined,
    );
    const observations = await this.propertyReader.read(
      requested,
      {
        client,
        source_id: miotSourceId(uid),
        collection_generation: generation,
        assertCurrent,
      },
      combined,
    );
    assertCurrent();
    const rejected = observations.some(
      (item) =>
        item.status === "unavailable" &&
        item.reason === "request_failed" &&
        item.error.kind === "authentication",
    );
    // Restore the shared account through its existing owner; never replay a read
    // or discard successful observations from earlier batches.
    if (rejected) void this.maintenance.renew(client);
    return observations;
  }

  private requireStore() {
    if (!this.credentialStore) throw new MijiaError("credential_storage");
    return this.credentialStore;
  }

  requestConnection() {
    if (this.stopped || this.loggingOut) throw new MijiaError("stale_session");
    if (this.state.connectionOperation?.status === "running")
      return this.snapshot();
    if (this.committingCredentials || this.initialRestorePending)
      throw new MijiaError("stale_session");
    this.requireStore();
    if (!this.accountClient && this.loginFlow.active)
      throw new MijiaError("not_bound");
    const now = new Date().toISOString();
    const operation: Operation = {
      id: crypto.randomUUID(),
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    this.state.connectionOperation = operation;
    this.changed();
    void this.reconnect(operation.id)
      .then((error) => {
        if (!this.isConnectionOperationCurrent(operation.id)) return;
        this.state.connectionOperation = error
          ? {
              ...operation,
              status: "failed",
              error,
              updatedAt: new Date().toISOString(),
            }
          : {
              ...operation,
              status: "succeeded",
              updatedAt: new Date().toISOString(),
            };
        this.changed();
      })
      .catch((error: unknown) => {
        if (!this.isConnectionOperationCurrent(operation.id)) return;
        this.state.connectionOperation = {
          ...operation,
          status: "failed",
          error: safeMijiaError(error).toPayload(),
          updatedAt: new Date().toISOString(),
        };
        this.changed();
      });
    return this.snapshot();
  }

  private isConnectionOperationCurrent(id: string) {
    return (
      !this.stopped &&
      !this.loggingOut &&
      this.state.connectionOperation?.id === id &&
      this.state.connectionOperation.status === "running"
    );
  }

  private cancelConnectionOperation() {
    const operation = this.state.connectionOperation;
    if (operation?.status === "running")
      this.state.connectionOperation = {
        ...operation,
        status: "cancelled",
        updatedAt: new Date().toISOString(),
      };
    this.changed();
  }

  private connectionFailure() {
    if (this.state.account.status !== "authenticated")
      return "error" in this.state.account
        ? this.state.account.error
        : new MijiaError("not_bound").toPayload();
    if (this.media.binding.status !== "ready")
      return "error" in this.media.binding
        ? this.media.binding.error
        : new MijiaError("go2rtc_unavailable").toPayload();
    if (this.discovery.stateSnapshot.status !== "ready")
      return "error" in this.discovery.stateSnapshot
        ? this.discovery.stateSnapshot.error
        : new MijiaError("devices_failed").toPayload();
    return undefined;
  }

  private async reconnect(id: string) {
    const assertCurrent = () => {
      if (!this.isConnectionOperationCurrent(id))
        throw new MijiaError("cancelled");
    };
    await this.media.reconcileConfiguration();
    assertCurrent();
    if (!this.accountClient) {
      await this.maintenance.retryRestore();
      assertCurrent();
      return this.connectionFailure();
    }
    if (this.maintenance.renewalFailed(this.accountClient)) {
      await this.maintenance.renew(this.accountClient);
      assertCurrent();
      if (
        !this.accountClient ||
        this.maintenance.renewalFailed(this.accountClient)
      )
        return this.connectionFailure();
    }
    if (this.media.binding.status !== "ready") {
      await this.media.retryBinding();
      assertCurrent();
    }
    if (this.discovery.stateSnapshot.status !== "ready") {
      await this.loadDevices();
      assertCurrent();
    }
    return this.connectionFailure();
  }

  private cancelRestore() {
    this.initialRestorePending = false;
    this.maintenance.cancelRestore();
  }

  private activeAccount(account: MiCloud) {
    return this.accountClient === account && !this.stopped && !this.loggingOut;
  }

  private stopAccountMaintenance() {
    this.discovery.pause();
    this.maintenance.stopRenewal();
  }

  private startAccountMaintenance(account: MiCloud) {
    this.discovery.pause();
    void this.loadAccountProfile(account);
    this.maintenance.scheduleRenewal(account);
    this.discovery.schedule(account);
    this.syncDirectoryNotifications();
  }

  private async loadAccountProfile(account: MiCloud) {
    try {
      const profile = await account.getProfile();
      if (
        this.activeAccount(account) &&
        this.state.account.status === "authenticated"
      ) {
        this.state.account = { ...this.state.account, profile };
        this.changed();
      }
    } catch {
      // Profile availability must not affect account authorization or devices.
    }
  }

  private async commitRenewed(
    account: MiCloud,
    candidate: AccountSessionCandidate,
    assertCurrent: () => void,
  ) {
    let reinstall = false;
    await this.serial(async () => {
      assertCurrent();
      const previous = account.getCredentials();
      const next = candidate.client.getCredentials();
      if (next.userId !== previous.userId || next.region !== previous.region)
        throw new MijiaError("authentication");
      this.committingCredentials = true;
      try {
        await mijiaOperation("credentials.save", "credential_storage", () =>
          this.requireStore().write("mijia", {
            micloud: candidate.client.exportSession(),
            oauth: candidate.oauth,
          }),
        );
        // A queued logout must delete the same durable and in-memory candidate.
        if (this.stopped || this.accountClient !== account) return;
        reinstall = this.media.needsRebind(
          next.passToken !== previous.passToken,
        );
        if (reinstall) this.media.prepareRebind();
        const oauthChanged =
          this.accountOAuth?.accessToken !== candidate.oauth.accessToken;
        this.invalidatePropertyReads();
        this.accountClient = candidate.client;
        this.accountOAuth = candidate.oauth;
        account.dispose();
        await this.commitCatalog(candidate.catalog, candidate.client, () => {
          if (!this.activeAccount(candidate.client))
            throw new MijiaError("stale_session");
        }).catch((error) =>
          this.discovery.fail(safeMijiaError(error, "devices_failed")),
        );
        this.startAccountMaintenance(candidate.client);
        if (oauthChanged) this.mqtt?.credentialsUpdated();
      } finally {
        this.committingCredentials = false;
      }
    });
    if (this.activeAccount(candidate.client) && reinstall)
      await this.media.startBinding();
  }

  private async commitRestored(
    candidate: AccountSessionCandidate,
    assertCurrent: () => void,
  ) {
    await this.serial(async () => {
      assertCurrent();
      if (this.accountClient) throw new MijiaError("stale_session");
      const selection = await this.requireHomeStore().read(
        this.accountKey(candidate.client),
      );
      const homeId = selection?.homeId ?? null;
      this.chooseDefaultHome = !selection;
      assertCurrent();
      await mijiaOperation("credentials.save", "credential_storage", () =>
        this.requireStore().write("mijia", {
          micloud: candidate.client.exportSession(),
          oauth: candidate.oauth,
        }),
      );
      assertCurrent();
      this.invalidateDeviceAccess();
      this.accountClient = candidate.client;
      this.accountOAuth = candidate.oauth;
      this.state.account = {
        status: "authenticated",
        id: crypto.randomUUID(),
        profile: null,
      };
      this.changed();
      this.discovery.acceptHome(homeId);
      await this.commitCatalog(
        candidate.catalog,
        candidate.client,
        assertCurrent,
      ).catch((error) =>
        this.discovery.fail(safeMijiaError(error, "devices_failed")),
      );
      this.startAccountMaintenance(candidate.client);
    });
    assertCurrent();
    if (this.activeAccount(candidate.client)) await this.media.startBinding();
  }

  private expireAccount(account: MiCloud, failure: MijiaError) {
    return this.serial(async () => {
      if (!this.activeAccount(account)) return;
      this.stopAccountMaintenance();
      this.media.cancelBinding();
      account.dispose();
      this.invalidateDeviceAccess();
      this.accountClient = undefined;
      this.accountOAuth = undefined;
      this.media.revokeAccount(false);
      this.discovery.reset();
      this.state.account = {
        status: "reauth_required",
        error: failure.toPayload(),
      };
      this.changed();
      await this.media.clearAdapter().catch(() => {});
    });
  }

  async logout() {
    if (this.stopped || this.loggingOut) throw new MijiaError("stale_session");
    const account = this.accountClient;
    const wasBinding = this.media.bindingPending;
    this.cancelConnectionOperation();
    this.loggingOut = true;
    this.invalidateDeviceAccess();
    this.stopAccountMaintenance();
    this.cancelRestore();
    this.media.cancelBinding();
    // A durable login write already in progress must finish selecting the same
    // account in memory before the queued deletion can succeed or fail.
    if (!this.committingCredentials) this.loginFlow.dispose();
    this.media.pauseSources();
    try {
      await this.serial(async () => {
        // Delete durable authorization first. Failure must never report a successful logout.
        try {
          await mijiaOperation("credentials.remove", "credential_storage", () =>
            this.requireStore().remove("mijia"),
          );
        } catch (error) {
          const failure = safeMijiaError(error, "credential_storage");
          this.state.account = this.accountClient
            ? this.state.account
            : { status: "restore_error", error: failure.toPayload() };
          this.changed();
          this.media.failInstalling(failure);
          throw failure;
        }
        this.loginFlow.dispose();
        this.invalidateDeviceAccess();
        this.accountClient?.dispose();
        this.accountClient = undefined;
        this.accountOAuth = undefined;
        this.discovery.reset();
        this.state.account = { status: "idle" };
        this.changed();
        this.state.connectionOperation = null;
        this.changed();
        this.media.revokeAccount();
        // Authorization is already revoked. A cleanup failure must remain a
        // media error, without restoring the account or reporting logout success.
        await this.media.clearAdapter();
      });
    } catch (error) {
      this.loggingOut = false;
      if (this.accountClient) {
        const accountChanged = this.accountClient !== account;
        if (this.media.resumeAfterLogout(wasBinding, accountChanged))
          void this.loadDevices().catch(() => {});
        this.startAccountMaintenance(this.accountClient);
      }
      throw error;
    } finally {
      this.loggingOut = false;
    }
    return this.snapshot();
  }

  private serial<T>(run: () => Promise<T>) {
    const result = this.lifecycleQueue.then(run);
    this.lifecycleQueue = result.catch(() => {});
    return result;
  }

  async initialize() {
    this.initialRestorePending = true;
    this.state.account = { status: "restoring" };
    this.changed();
    try {
      try {
        const record = await this.requireStore().read("mijia");
        const parsed = accountSessionSchema.safeParse(record?.value);
        if (parsed.success && this.initialRestorePending) {
          const accountId = JSON.stringify([
            parsed.data.micloud.region,
            parsed.data.micloud.userId,
          ]);
          const selection = await this.requireHomeStore().read(accountId);
          if (this.initialRestorePending)
            await this.household?.restore(accountId, selection?.homeId ?? null);
        }
      } catch {
        /* Account maintenance reports storage failures through its public state. */
      }
      await this.media.initialize();
      if (this.initialRestorePending) await this.maintenance.restore();
    } finally {
      this.initialRestorePending = false;
      this.media.startConfigurationChecks();
    }
  }

  snapshot() {
    return structuredClone({
      ...this.state,
      homes: this.discovery.homeSnapshot(),
      revision: this.media.mediaRevision,
      binding: this.media.binding,
      loginAttempt: this.loginFlow.state,
      devices: this.discovery.snapshot(),
    });
  }

  startLogin() {
    if (this.stopped || this.committingCredentials || this.loggingOut)
      throw new MijiaError("stale_session");
    this.requireStore();
    this.cancelConnectionOperation();
    this.cancelRestore();
    if (!this.accountClient) this.state.account = { status: "idle" };
    this.changed();
    this.loginFlow.start();
    return this.snapshot();
  }

  cancelLogin(id: string) {
    if (!this.stopped && !this.loggingOut && !this.committingCredentials)
      this.loginFlow.cancel(id);
    return this.snapshot();
  }

  async verifyLogin(id: string, ticket: string) {
    if (this.stopped || this.loggingOut || this.committingCredentials)
      throw new MijiaError("stale_session");
    await this.loginFlow.verifyLogin(id, ticket);
    return this.snapshot();
  }

  private async commitLogin(attempt: LoginCandidate) {
    if (!this.loginFlow.isCurrent(attempt)) return;
    attempt.cloud.getCredentials();
    this.loginFlow.prepareCommit(attempt);
    const oauth = await mijiaOperation(
      "oauth.authorize",
      "authentication",
      () =>
        authorizeOAuth(
          attempt.cloud.exportSession(),
          attempt.controller.signal,
        ),
    );
    await this.serial(async () => {
      if (!this.loginFlow.isCurrent(attempt)) return;
      const selection = await this.requireHomeStore().read(
        this.accountKey(attempt.cloud),
      );
      const homeId = selection?.homeId ?? null;
      this.chooseDefaultHome = !selection;
      if (!this.loginFlow.isCurrent(attempt)) return;
      const previousAccount = this.accountClient;
      this.stopAccountMaintenance();
      this.committingCredentials = true;
      try {
        await mijiaOperation("credentials.save", "credential_storage", () =>
          this.requireStore().write("mijia", {
            micloud: attempt.cloud.exportSession(),
            oauth,
          }),
        );
        if (!this.loginFlow.isCurrent(attempt)) return;
        this.cancelRestore();
        this.invalidateDeviceAccess();
        this.media.revokeAccount();
        this.discovery.reset();
        this.accountClient?.dispose();
        this.accountClient = attempt.cloud;
        this.accountOAuth = oauth;
        this.state.account = {
          id: crypto.randomUUID(),
          status: "authenticated",
          profile: null,
        };
        this.changed();
        this.discovery.acceptHome(homeId);
        this.loginFlow.adopt(attempt);
        this.state.connectionOperation = null;
        this.changed();
        this.startAccountMaintenance(attempt.cloud);
      } finally {
        this.committingCredentials = false;
        if (previousAccount && this.activeAccount(previousAccount))
          this.startAccountMaintenance(previousAccount);
      }
    });
    if (
      this.accountClient === attempt.cloud &&
      !this.stopped &&
      !this.loggingOut
    ) {
      await this.loadDevices();
    }
  }

  getDeviceSpec(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.household?.ready()) throw new MijiaError("devices_failed");
    return this.household.specification(id);
  }

  async loadDevices() {
    await this.discovery.load();
    return this.snapshot();
  }

  reservePlayback(revision: string, deviceId: string, channel: 1 | 2) {
    if (!this.household?.ready()) throw new MijiaError("devices_failed");
    this.discovery.requireHome();
    if (!this.discovery.find(deviceId))
      throw new MijiaError("device_not_found");
    return this.media.reservePlayback(revision, deviceId, channel);
  }
  offer(revision: string, id: string, sdp: string, signal: AbortSignal) {
    return this.media.offer(revision, id, sdp, signal);
  }
  playbackSnapshot(id: string) {
    return this.media.playbackSnapshot(id);
  }
  release(id: string) {
    return this.media.release(id);
  }

  async close() {
    this.cancelConnectionOperation();
    this.stopped = true;
    const maintenanceClosing = this.maintenance.shutdown();
    this.invalidateDeviceAccess();
    this.initialRestorePending = false;
    this.discovery.pause();
    this.media.cancelBinding();
    this.loginFlow.dispose();
    this.accountClient?.dispose();
    this.accountClient = undefined;
    this.accountOAuth = undefined;
    this.discovery.reset();
    try {
      await this.media.close();
    } finally {
      await Promise.allSettled([
        maintenanceClosing,
        this.lifecycleQueue,
        this.mqttClosing,
      ]);
    }
  }
}
