import type { DeviceControl } from "../../household/operations/control";
import type { MijiaService } from "../service";

export function createMijiaDeviceControl(service: MijiaService) {
  return {
    dispatch: async (target, signal, assertCurrent, onSendStarted) => {
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
          onSendStarted,
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
        onSendStarted,
      );
    },
  } satisfies DeviceControl;
}
