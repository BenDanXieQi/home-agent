import type { MijiaService } from "../service";
import { MijiaError } from "../errors";
import type { accessHousehold } from "../../household/access";

export function accessMaterialDevice(
  mijia: MijiaService,
  scope: ReturnType<typeof accessHousehold>,
  deviceId: string,
  signal: AbortSignal,
) {
  const session = mijia.materialSession(signal, deviceId);
  const device = session.devices().find((item) => item.did === deviceId);
  if (!device) throw new MijiaError("device_not_found");
  const assertCurrent = () => {
    scope.assertCurrent();
    session.assertCurrent();
    const current = session.devices().find((item) => item.did === deviceId);
    if (!current) throw new MijiaError("device_not_found");
  };
  assertCurrent();
  return { device, session, scope: { ...scope, assertCurrent } };
}
