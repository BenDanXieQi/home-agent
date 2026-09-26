import { MiotMqtt } from "./protocols/miot/mqtt";
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
import { DeviceQueries } from "./devices/queries";
import { mijiaOperation } from "./operation";

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
  private accountOAuth: AccountSessionCandidate["oauth"] | undefined;
  private readonly loginFlow = new LoginFlow((candidate) =>
    this.commitLogin(candidate),
  );
  private lifecycleQueue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  private initialRestorePending = false;
  private committingCredentials = false;
  private loggingOut = false;

  private readonly media: MediaSession;
  private readonly discovery: DeviceDiscovery;
  private readonly queries: DeviceQueries;
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
      currentAccount: () => this.accountClient,
      acceptsWork: () => !this.stopped && !this.loggingOut,
      stopped: () => this.stopped,
      canReconfigure: () =>
        !this.stopped && !this.loggingOut && !this.committingCredentials,
      serial: (run) => this.serial(run),
    });
    this.discovery = new DeviceDiscovery({
      currentAccount: () => this.accountClient,
      activeAccount: (account) => this.activeAccount(account),
      stopped: () => this.stopped,
      renewalFailed: (account) => this.maintenance.renewalFailed(account),
      renew: (account) => this.maintenance.renew(account),
      retainedChannels: (id) => this.media.retainedChannels(id),
      onScopeChanged: () => {
        this.invalidatePropertyReads();
        this.media.prepareRebind();
        void this.media.startBinding().catch(() => {});
      },
      onDevices: (devices, retryFailed) =>
        this.media.updateDevices(devices, retryFailed),
    });
    this.queries = new DeviceQueries({
      currentAccount: () => this.accountClient,
      activeAccount: (account) => this.activeAccount(account),
      discovery: this.discovery,
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
      },
      onRenewalFailure: async (account, failure) => {
        if (failure.reason === "authentication")
          await this.expireAccount(account, failure);
        else if (this.activeAccount(account)) this.discovery.fail(failure);
      },
    });
  }

  private mqtt: MiotMqtt | undefined;
  private mqttClosing: Promise<void> = Promise.resolve();
  private readScope = new AbortController();
  private readGeneration = crypto.randomUUID();
  private readonly propertyReader = new PropertyReader();
  private readonly credentialStore: CredentialStore | undefined;
  private readonly homeSelectionStore: HomeSelectionStore | undefined;

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
  async selectHome(accountId: string, homeId: string | null) {
    await this.serial(async () => {
      const account = this.accountClient;
      if (!account) throw new MijiaError("not_bound");
      if (
        !this.activeAccount(account) ||
        this.state.account.status !== "authenticated" ||
        this.state.account.id !== accountId
      )
        throw new MijiaError("stale_session");
      this.discovery.validateSelection(homeId);
      await this.requireHomeStore().write(this.accountKey(account), homeId);
      this.discovery.select(homeId);
    });
    return this.snapshot();
  }

  private invalidatePropertyReads() {
    const mqtt = this.mqtt;
    this.mqtt = undefined;
    if (mqtt)
      this.mqttClosing = Promise.all([
        this.mqttClosing,
        mqtt.close("scope_invalidated"),
      ]).then(() => {});
    this.readScope.abort();
    this.readScope = new AbortController();
    this.readGeneration = crypto.randomUUID();
  }

  async observeDevices(
    deviceIds: readonly string[],
    onObservation: (observation: MiotObservation) => void,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const account = this.accountClient;
    const oauth = this.accountOAuth;
    if (!account || !oauth) throw new MijiaError("not_bound");
    const ids = [...new Set(deviceIds)];
    if (!ids.length) throw new MijiaError("invalid_input");
    const scope = this.readScope.signal;
    const combined = AbortSignal.any([signal, scope]);
    const assertCurrent = () => {
      combined.throwIfAborted();
      if (!this.activeAccount(account) || this.accountOAuth !== oauth)
        throw new MijiaError("stale_session");
      this.discovery.requireHome();
      if (this.discovery.stateSnapshot.status !== "ready")
        throw new MijiaError("devices_failed");
      if (ids.some((id) => !this.discovery.find(id)))
        throw new MijiaError("device_not_found");
    };
    assertCurrent();
    return this.serial(async () => {
      await this.mqttClosing;
      assertCurrent();
      if (oauth.expiresAt <= Date.now()) throw new MijiaError("authentication");
      if (this.mqtt?.closed) {
        await this.mqtt.close();
        this.mqtt = undefined;
      }
      assertCurrent();
      const mqtt = (this.mqtt ??= new MiotMqtt(
        miotPushSourceId(account.getCredentials().userId),
        oauth,
      ));
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
    const client = this.accountClient;
    if (!client) throw new MijiaError("not_bound");
    if (!this.activeAccount(client)) throw new MijiaError("stale_session");
    const uid = client.getCredentials().userId;
    const generation = this.readGeneration;
    this.discovery.requireHome();
    if (this.discovery.stateSnapshot.status !== "ready")
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
      if (this.discovery.stateSnapshot.status !== "ready")
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
    const requested = await preparePropertyRead(
      propertiesSnapshot,
      {
        getDeviceSpec: (did, readSignal) =>
          this.queries.getDeviceSpec(did, readSignal),
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
      })
      .catch((error: unknown) => {
        if (!this.isConnectionOperationCurrent(operation.id)) return;
        this.state.connectionOperation = {
          ...operation,
          status: "failed",
          error: safeMijiaError(error).toPayload(),
          updatedAt: new Date().toISOString(),
        };
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
  }

  private async loadAccountProfile(account: MiCloud) {
    try {
      const profile = await account.getProfile();
      if (
        this.activeAccount(account) &&
        this.state.account.status === "authenticated"
      ) {
        this.state.account = { ...this.state.account, profile };
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
        this.invalidatePropertyReads();
        this.accountClient = candidate.client;
        this.accountOAuth = candidate.oauth;
        account.dispose();
        this.discovery.set(candidate.catalog, true);
        this.startAccountMaintenance(candidate.client);
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
      const homeId = await this.requireHomeStore().read(
        this.accountKey(candidate.client),
      );
      assertCurrent();
      await mijiaOperation("credentials.save", "credential_storage", () =>
        this.requireStore().write("mijia", {
          micloud: candidate.client.exportSession(),
          oauth: candidate.oauth,
        }),
      );
      assertCurrent();
      this.invalidatePropertyReads();
      this.accountClient = candidate.client;
      this.accountOAuth = candidate.oauth;
      this.discovery.set(candidate.catalog);
      this.state.account = {
        status: "authenticated",
        id: crypto.randomUUID(),
        profile: null,
      };
      this.discovery.select(homeId);
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
      this.invalidatePropertyReads();
      this.accountClient = undefined;
      this.accountOAuth = undefined;
      this.media.resetAccount(false);
      this.discovery.reset();
      this.state.account = {
        status: "reauth_required",
        error: failure.toPayload(),
      };
      await this.media.clearAdapter().catch(() => {});
    });
  }

  async logout() {
    if (this.stopped || this.loggingOut) throw new MijiaError("stale_session");
    const account = this.accountClient;
    const wasBinding = this.media.bindingPending;
    this.cancelConnectionOperation();
    this.loggingOut = true;
    this.invalidatePropertyReads();
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
          this.media.failInstalling(failure);
          throw failure;
        }
        this.loginFlow.dispose();
        this.invalidatePropertyReads();
        this.accountClient?.dispose();
        this.accountClient = undefined;
        this.accountOAuth = undefined;
        this.discovery.reset();
        this.state.account = { status: "idle" };
        this.state.connectionOperation = null;
        this.media.resetAccount();
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
    try {
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
      const homeId = await this.requireHomeStore().read(
        this.accountKey(attempt.cloud),
      );
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
        this.invalidatePropertyReads();
        this.media.resetAccount();
        this.discovery.reset();
        this.accountClient?.dispose();
        this.accountClient = attempt.cloud;
        this.accountOAuth = oauth;
        this.state.account = {
          id: crypto.randomUUID(),
          status: "authenticated",
          profile: null,
        };
        this.discovery.select(homeId);
        this.loginFlow.adopt(attempt);
        this.state.connectionOperation = null;
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
      const discovery = this.loadDevices().catch(() => {});
      await Promise.all([discovery, this.media.startBinding()]);
    }
  }

  getHome(signal?: AbortSignal) {
    return this.queries.getHome(signal);
  }
  getDeviceSpec(id: string, signal?: AbortSignal) {
    return this.queries.getDeviceSpec(id, signal);
  }

  async loadDevices() {
    await this.discovery.load();
    return this.snapshot();
  }

  reservePlayback(revision: string, deviceId: string, channel: 1 | 2) {
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
    this.invalidatePropertyReads();
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
