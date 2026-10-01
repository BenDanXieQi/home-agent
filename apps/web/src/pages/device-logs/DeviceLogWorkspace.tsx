import {
  memo,
  useCallback,
  useDeferredValue,
  useState,
  useSyncExternalStore,
} from "react";
import { Group, Panel } from "react-resizable-panels";
import type { useDeviceLogs } from "../../modules/device-logs/use-device-logs";
import type { DeviceLogSnapshot } from "@home-agent/api/device-logs";
import { ResizeHandle } from "../../components/ResizeHandle";
import { CaptureControls } from "./CaptureControls";
import { DevicePicker } from "./DevicePicker";
import { LogReader } from "./LogReader";
import { useDeviceSelection } from "./use-device-selection";
import { useLogComparison } from "./use-log-comparison";

const narrowQuery = "(width < 901px)";
const subscribeNarrow = (notify: () => void) => {
  const query = matchMedia(narrowQuery);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const readNarrow = () => matchMedia(narrowQuery).matches;

const emptyDevices: NonNullable<DeviceLogSnapshot["run"]>["devices"] = [];

export const DeviceLogWorkspace = memo(function DeviceLogWorkspace({
  data,
  connected,
  loaded,
  ready,
}: Pick<ReturnType<typeof useDeviceLogs>, "data" | "connected" | "loaded"> & {
  ready: boolean;
}) {
  const { run } = data;
  const capturing = run?.status === "capturing";
  const [frozen, setFrozen] = useState<DeviceLogSnapshot | null>(null);
  const paused = capturing && frozen !== null && frozen.run?.id === run?.id;
  const displayed = paused ? frozen : data;
  const deferred = useDeferredValue(displayed);
  const entries =
    capturing && deferred.run?.id === run?.id
      ? deferred.entries
      : displayed.entries;
  const unseen = paused
    ? Math.max(0, (run?.total_rows ?? 0) - (frozen.run?.total_rows ?? 0))
    : 0;
  const resume = useCallback(() => setFrozen(null), []);
  const setLive = useCallback(
    (live: boolean) => setFrozen(live ? null : data),
    [data],
  );
  const [devicesOpen, setDevicesOpen] = useState(false);
  const selection = useDeviceSelection(
    displayed.run?.devices ?? emptyDevices,
    run?.devices ?? emptyDevices,
  );
  const comparison = useLogComparison(
    displayed.run?.devices ?? emptyDevices,
    run?.id,
  );
  const { comparing, enterComparison, leaveComparison } = comparison;
  const { deviceId } = selection;
  const toggleComparison = useCallback(() => {
    if (comparing) leaveComparison();
    else {
      enterComparison(deviceId);
      setDevicesOpen(true);
    }
  }, [comparing, enterComparison, leaveComparison, deviceId]);
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow);
  const picker = (
    <DevicePicker
      selection={selection}
      comparison={comparison}
      loaded={loaded}
      hasRun={!!run}
      open={devicesOpen}
      onOpenChange={setDevicesOpen}
    />
  );
  const reader = (
    <LogReader
      entries={entries}
      selection={selection}
      comparison={comparison}
      runId={run?.id}
      hasRun={!!run}
      loaded={loaded}
      capturing={capturing}
      paused={paused}
      onResume={resume}
      onToggleComparison={toggleComparison}
    />
  );
  return (
    <section className="flex h-full min-h-0 flex-col gap-4 [--switch-on:var(--color-ink)] [--segmented-accent:var(--color-ink)] [&_button:focus-visible]:outline-1 [&_button:focus-visible]:outline-ink/50 [&_button:focus-visible]:-outline-offset-2">
      <div className="shrink-0 empty:hidden">
        <CaptureControls
          run={run}
          connected={connected}
          loaded={loaded}
          ready={ready}
          paused={paused}
          unseen={unseen}
          onLiveChange={setLive}
          onCaptured={resume}
        />
      </div>
      {narrow ? (
        <div
          className="relative grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] bg-white data-[devices-open=true]:grid-rows-[minmax(0,1fr)_minmax(0,1fr)]"
          data-devices-open={devicesOpen}
        >
          {picker}
          {reader}
        </div>
      ) : (
        <Group
          className="relative min-h-0 flex-1 bg-white"
          id="device-log-panels"
        >
          <Panel
            id="device-list"
            defaultSize="250px"
            minSize="200px"
            maxSize="380px"
          >
            {picker}
          </Panel>
          <ResizeHandle label="调整设备列表宽度" />
          <Panel id="log-reader" minSize="0px">
            {reader}
          </Panel>
        </Group>
      )}
    </section>
  );
});
