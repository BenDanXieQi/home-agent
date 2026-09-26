import type { MiCloud } from "../protocols/micloud";
import { describeMijiaDevice } from "./mapping";
import { MijiaError } from "../errors";

/** Membership completeness belongs to the bound household, not the account. */
export function assertCompleteHome(
  catalog: Awaited<ReturnType<MiCloud["getCatalog"]>>,
  homeId: string | null,
) {
  const home = catalog.homes.find((item) => item.id === homeId);
  if (!home) return;
  const details = new Set(
    catalog.devices
      .filter((device) => device.home_id === homeId)
      .map((device) => device.did),
  );
  for (const id of [
    ...home.deviceIds,
    ...home.rooms.flatMap((room) => room.deviceIds),
  ])
    if (!details.has(id)) throw new MijiaError("cloud_invalid_response");
}

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
