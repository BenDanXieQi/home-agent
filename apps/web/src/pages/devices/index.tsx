import { useAtomValue } from "jotai";
import { useRef } from "react";
import { HouseholdAccess } from "../../modules/household/HouseholdAccess";
import { householdReliableAtom } from "../../modules/household/sync";
import {
  deviceInventoryAtom,
  deviceCountAtom,
} from "../../modules/devices/state";
import { InventoryNotice } from "../../modules/devices/InventoryNotice";
import { PageHeaderCount } from "../../components/PageHeaderContent";
import { DeviceBrowser } from "./DeviceBrowser";
import { DeviceBrowserSkeleton } from "./skeletons";
import { DeviceRecovery } from "./DeviceRecovery";

export default function DevicesPage() {
  const layoutRef = useRef<HTMLDivElement>(null);
  const inventory = useAtomValue(deviceInventoryAtom);
  const count = useAtomValue(deviceCountAtom);
  const reliable = useAtomValue(householdReliableAtom);
  return (
    <div ref={layoutRef}>
      <PageHeaderCount
        count={count}
        loading={!inventory || inventory.status === "loading"}
        label="设备"
      />
      <InventoryNotice />
      <DeviceRecovery />
      <HouseholdAccess fallback={<DeviceBrowserSkeleton />}>
        {inventory ? (
          <DeviceBrowser
            status={inventory.status}
            reliable={reliable}
            layoutRef={layoutRef}
          />
        ) : null}
      </HouseholdAccess>
    </div>
  );
}
