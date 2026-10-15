import { propertyKey } from "@home-agent/api/observations";
import type { AutomationProperties } from "../household/automations/properties";
import { mijiaPropertyAddress } from "./control/addresses";

export const mijiaAutomationProperties = {
  key(accountId, property) {
    const address = mijiaPropertyAddress(property.property_key);
    if (!address) return undefined;
    return propertyKey(
      accountId,
      property.device_id,
      address.siid,
      address.piid,
    );
  },
  reference(fact) {
    return {
      device_id: fact.device_id,
      property_key: `prop.${fact.siid}.${fact.piid}`,
    };
  },
  reported(snapshot, event) {
    return snapshot.projection.latest[
      propertyKey(
        snapshot.projection.household.household.account_id ?? "",
        event.did,
        event.siid,
        event.piid,
      )
    ];
  },
} satisfies AutomationProperties;
