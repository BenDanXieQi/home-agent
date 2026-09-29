import { deviceLogScopeAtom } from "../../modules/device-logs/state";
import { useAtomValue } from "jotai";
import { householdAtom } from "../../modules/household/state";
import { useDeviceLogs } from "../../modules/device-logs/use-device-logs";
import { DeviceLogWorkspace } from "./DeviceLogWorkspace";

export default function DeviceLogsPage() {
  const household = useAtomValue(householdAtom);
  const scope = useAtomValue(deviceLogScopeAtom);
  const { data, connected, loaded } = useDeviceLogs(scope);
  return (
    <DeviceLogWorkspace
      key={scope}
      data={data}
      connected={connected}
      loaded={loaded}
      ready={household?.status === "running"}
    />
  );
}
