import type { MiCloud } from "../protocols/micloud";
import { describeMijiaDevice } from "./mapping";

/** Convert a vendor catalog into the selected household's directory candidate. */
export function deviceDirectory(
  catalog: Awaited<ReturnType<MiCloud["getCatalog"]>>,
  accountId: string,
  homeId: string | null,
) {
  return {
    accountId,
    homeId,
    homes: catalog.homes.map(({ id, name, shared, rooms }) => ({
      id,
      name,
      shared,
      rooms: rooms.map((room) => ({ id: room.id, name: room.name })),
    })),
    devices: catalog.devices
      .filter((device) => device.home_id === homeId)
      .map((device) => ({
        ...describeMijiaDevice(device),
        spec_type: device.spec_type ?? null,
      })),
  };
}
