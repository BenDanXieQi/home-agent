import type { MijiaHome, MijiaDeviceSpec } from "@home-agent/api/mijia";
import { MijiaError } from "../errors";
import { mijiaOperation } from "../operation";
import { MiCloudError, type MiCloud } from "../protocols/micloud";
import type { DeviceDiscovery } from "./discovery";

export const SPEC_REQUEST_CONCURRENCY = 3;

type DeviceQueryDependencies = {
  currentAccount: () => MiCloud | undefined;
  activeAccount: (account: MiCloud) => boolean;
  discovery: DeviceDiscovery;
};

/** Reads the current discovery catalog without owning another device snapshot. */
export class DeviceQueries {
  constructor(private readonly dependencies: DeviceQueryDependencies) {}

  async getHome(signal?: AbortSignal) {
    const { currentAccount, activeAccount, discovery } = this.dependencies;
    const account = currentAccount();
    if (!account) throw new MijiaError("not_bound");
    if (!activeAccount(account)) throw new MijiaError("stale_session");
    if (discovery.stateSnapshot.status !== "ready")
      throw new MijiaError("devices_failed");
    const home = discovery.requireHome();
    const revision = discovery.revision;
    const source = discovery.list();
    const devices: MijiaHome["devices"] = [];
    // Bound concurrent metadata requests when filling a cold spec cache.
    for (
      let offset = 0;
      offset < source.length;
      offset += SPEC_REQUEST_CONCURRENCY
    ) {
      const batch = await Promise.all(
        source
          .slice(offset, offset + SPEC_REQUEST_CONCURRENCY)
          .map(async (device) => ({
            ...(await this.getDeviceSpec(device.did, signal)),
            sub_devices: null,
          })),
      );
      devices.push(...batch);
    }
    if (
      !activeAccount(account) ||
      discovery.revision !== revision ||
      source.some((device) => discovery.find(device.did) !== device)
    )
      throw new MijiaError("stale_session");
    return {
      home_name: home.name,
      devices,
      areas: home.rooms.map(({ name }) => ({ name })),
      scenes: [],
      persons: [],
    };
  }

  async getDeviceSpec(id: string, signal?: AbortSignal) {
    const { currentAccount, activeAccount, discovery } = this.dependencies;
    const account = currentAccount();
    if (!account) throw new MijiaError("not_bound");
    if (!activeAccount(account)) throw new MijiaError("stale_session");
    discovery.requireHome();
    const revision = discovery.revision;
    const device = discovery.find(id);
    if (!device) throw new MijiaError("device_not_found");
    return mijiaOperation("devices.spec", "spec_failed", async () => {
      const spec = await account
        .getDeviceSpec(device, signal)
        .catch((error: unknown) => {
          if (
            !(error instanceof MiCloudError) ||
            error.code !== "spec-unavailable"
          )
            throw error;
          const capabilities: MijiaDeviceSpec["spec"] = {};
          return {
            did: device.did,
            name: device.name ?? "",
            home: device.home_name ?? "",
            room: device.room_name ?? "",
            model: device.model ?? "",
            online: device.isOnline === true,
            category: null,
            spec: capabilities,
          };
        });
      if (!activeAccount(account) || discovery.revision !== revision)
        throw new MijiaError("stale_session");
      const current = discovery.find(id);
      if (
        !current ||
        current.home_id !== device.home_id ||
        current.model !== device.model ||
        current.spec_type !== device.spec_type
      )
        throw new MijiaError("stale_session");
      return {
        ...spec,
        name: current.name ?? "",
        home: current.home_name ?? "",
        room: current.room_name ?? "",
        online: current.isOnline === true,
      };
    });
  }
}
