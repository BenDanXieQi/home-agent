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
  const device = session.device;
  if (!device) throw new MijiaError("device_not_found");
  const assertCurrent = () => {
    scope.assertCurrent();
    session.assertCurrent();
  };
  assertCurrent();
  return { device, session, scope: { ...scope, assertCurrent } };
}
