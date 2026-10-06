import type { z } from "zod";
import type {
  agentContextPartsSchema,
  agentDevicePropertySchema,
} from "../contracts/agent-context";

/** Resolve only metadata actually present in this received inventory. */
export function createAgentDeviceMetadata(
  household: z.infer<typeof agentContextPartsSchema>["household"] | undefined,
) {
  const data = household?.status === "ready" ? household.data : undefined;
  const devices = new Map(
    Object.values(data?.device ?? {}).map((item) => [
      JSON.stringify([item.account_id, item.device_id]),
      item,
    ]),
  );
  function device(
    identity: Pick<
      z.infer<typeof agentDevicePropertySchema>,
      "account_id" | "device_id"
    >,
  ) {
    const found = devices.get(
      JSON.stringify([identity.account_id, identity.device_id]),
    );
    return {
      account_id: identity.account_id,
      device_id: identity.device_id,
      device_name: found?.name ?? null,
      room_name: found?.room_name ?? null,
    };
  }
  function resolveProperty(
    address: Pick<
      z.infer<typeof agentDevicePropertySchema>,
      "account_id" | "device_id" | "siid" | "piid"
    >,
  ) {
    const found = devices.get(
      JSON.stringify([address.account_id, address.device_id]),
    );
    const capability = found?.spec_id
      ? data?.specs[found.spec_id]?.spec[`prop.${address.siid}.${address.piid}`]
      : undefined;
    return {
      ...device(address),
      siid: address.siid,
      piid: address.piid,
      capability: capability ?? null,
    };
  }
  const properties = new WeakMap<
    Parameters<typeof resolveProperty>[0],
    ReturnType<typeof resolveProperty>
  >();
  return {
    device,
    property(address: Parameters<typeof resolveProperty>[0]) {
      let result = properties.get(address);
      if (!result) {
        result = resolveProperty(address);
        properties.set(address, result);
      }
      return result;
    },
  };
}
