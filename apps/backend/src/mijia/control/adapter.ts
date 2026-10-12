import type { DeviceControl } from "../../household/operations/control";
import type { MijiaService } from "../service";
import { safeMijiaError } from "../errors";

export function createMijiaDeviceControl(service: MijiaService) {
  return {
    endpoint: (target) =>
      target.kind === "property" ? "/miotspec/prop/set" : "/miotspec/action",
    dispatch: async (target, signal, assertCurrent) => {
      if (target.kind === "property") {
        const results = await service.writeProperties(
          [
            {
              did: target.device_id,
              siid: target.siid,
              piid: target.piid,
              value: target.value,
            },
          ],
          signal,
          assertCurrent,
        );
        return results[0]!;
      }
      return service.invokeAction(
        {
          did: target.device_id,
          siid: target.siid,
          aiid: target.aiid,
          in: target.inputs,
        },
        signal,
        assertCurrent,
      );
    },
    failure: (error) => safeMijiaError(error).toPayload(),
  } satisfies DeviceControl;
}
