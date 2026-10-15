import type { DeviceControl } from "../../household/operations/control";
import type { MijiaService } from "../service";
import { MijiaError } from "../errors";
import { mijiaActionAddress, mijiaPropertyAddress } from "./addresses";

function commandTarget(command: Parameters<DeviceControl["prepare"]>[0]) {
  if (command.kind === "property") {
    const address = mijiaPropertyAddress(command.property_key);
    if (!address) throw new MijiaError("invalid_input");
    return {
      kind: command.kind,
      device_id: command.device_id,
      ...address,
      value: command.value,
    };
  }
  const address = mijiaActionAddress(command.action_key);
  if (!address) throw new MijiaError("invalid_input");
  return {
    kind: command.kind,
    device_id: command.device_id,
    ...address,
    inputs: command.inputs,
  };
}

export function createMijiaDeviceControl(service: MijiaService) {
  return {
    prepare(command) {
      const target = commandTarget(command);
      return {
        target,
        async dispatch(signal, assertCurrent, onSendStarted) {
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
      };
    },
  } satisfies DeviceControl;
}
