import type { MijiaDeviceSpec } from "@home-agent/api/mijia";
import { MijiaError } from "../errors";
import type { MiotPropertyAddress } from "../protocols/micloud/properties";

type PropertyReadPreparation = {
  getDeviceSpec: (did: string, signal: AbortSignal) => MijiaDeviceSpec;
  assertCurrent: () => void;
};

/** Verify each device's requested properties once before consuming HTTP budget. */
export function preparePropertyRead(
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
  for (const [did, group] of byDevice) {
    const spec = preparation.getDeviceSpec(did, signal);
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
  }
  signal.throwIfAborted();
  preparation.assertCurrent();
  return requested;
}
