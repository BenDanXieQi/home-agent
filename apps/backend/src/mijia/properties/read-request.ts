import {
  SPEC_REQUEST_CONCURRENCY,
  type DeviceQueries,
} from "../devices/queries";
import { MijiaError } from "../errors";
import type { MiotPropertyAddress } from "../protocols/micloud/properties";

type PropertyReadPreparation = Pick<DeviceQueries, "getDeviceSpec"> & {
  assertCurrent: () => void;
};

/** Verify each device's requested properties once before consuming HTTP budget. */
export async function preparePropertyRead(
  properties: readonly MiotPropertyAddress[],
  preparation: PropertyReadPreparation,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  preparation.assertCurrent();
  const requested = properties.map((property) => ({ ...property }));
  const byDevice = new Map<string, MiotPropertyAddress[]>();
  for (const property of requested) {
    const group = byDevice.get(property.did);
    if (group) group.push(property);
    else byDevice.set(property.did, [property]);
  }
  const groups = [...byDevice];
  for (
    let offset = 0;
    offset < groups.length;
    offset += SPEC_REQUEST_CONCURRENCY
  ) {
    await Promise.all(
      groups
        .slice(offset, offset + SPEC_REQUEST_CONCURRENCY)
        .map(async ([did, group]) => {
          const spec = await preparation.getDeviceSpec(did, signal);
          signal.throwIfAborted();
          preparation.assertCurrent();
          for (const property of group) {
            if (
              !Number.isSafeInteger(property.siid) ||
              property.siid < 1 ||
              !Number.isSafeInteger(property.piid) ||
              property.piid < 1 ||
              !spec.spec[`prop.${property.siid}.${property.piid}`]?.readable
            )
              throw new MijiaError("property_not_readable");
          }
        }),
    );
    signal.throwIfAborted();
    preparation.assertCurrent();
  }
  return requested;
}
