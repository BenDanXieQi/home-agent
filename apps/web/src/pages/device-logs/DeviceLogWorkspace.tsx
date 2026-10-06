import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { useAtomValue } from "jotai";
import { Group, Panel } from "react-resizable-panels";
import {
  deviceHistoryPolicy,
  deviceHistoryQuerySchema,
} from "@home-agent/api/device-history";
import { devicesAtom } from "../../modules/devices/state";
import {
  historyDevices,
  historyLogEntries,
} from "../../modules/device-history/presentation";
import { useDeviceHistory } from "../../modules/device-history/use-device-history";
import { ResizeHandle } from "../../components/ResizeHandle";
import { HistoryControls } from "./HistoryControls";
import { DevicePicker } from "./DevicePicker";
import { LogReader } from "./LogReader";
import { historyRangePresets, logViews } from "./log-data";
import { useDeviceSelection } from "./use-device-selection";
import { useLogComparison } from "./use-log-comparison";

const narrowQuery = "(width < 901px)";
const subscribeNarrow = (notify: () => void) => {
  const query = matchMedia(narrowQuery);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const readNarrow = () => matchMedia(narrowQuery).matches;

export function DeviceLogWorkspace({
  scope,
  accountId,
  homeId,
  ready,
}: {
  scope: string;
  accountId: string;
  homeId: string;
  ready: boolean;
}) {
  const devices = useAtomValue(devicesAtom);
  const allDevices = useMemo(() => historyDevices(devices), [devices]);
  const selection = useDeviceSelection(allDevices);
  const [range, setRange] = useState(() => {
    const end = Date.now();
    return {
      start: new Date(end - historyRangePresets[1]!.duration).toISOString(),
      end: new Date(end).toISOString(),
    };
  });
  const [selectedRange, setSelectedRange] = useState<
    ComponentProps<typeof HistoryControls>["selectedRange"]
  >(historyRangePresets[1]!.duration);
  const [live, setLive] = useState(true);
  const [view, setView] = useState<(typeof logViews)[number]["value"]>("all");
  const [devicesOpen, setDevicesOpen] = useState(false);
  const comparison = useLogComparison(
    allDevices,
    JSON.stringify([range, view]),
  );
  const ids = comparison.comparing
    ? comparison.compareIds
    : selection.deviceId
      ? [selection.deviceId]
      : selection.filtering
        ? [...selection.visibleIds]
        : undefined;
  const input = deviceHistoryQuerySchema.parse({
    account_id: accountId,
    home_id: homeId,
    ...range,
    kinds: view === "all" ? ["property", "online"] : [view],
    ...(ids?.length ? { device_ids: ids } : {}),
    order: "desc",
    limit: deviceHistoryPolicy.maxLimit,
  });
  const noDevices = ids !== undefined && ids.length === 0;
  const history = useDeviceHistory(scope, input, ready && !noDevices, live);
  const entries = useMemo(
    () =>
      historyLogEntries(
        noDevices ? [] : (history.displayData?.records ?? []),
        devices,
      ),
    [history.displayData?.records, devices, noDevices],
  );
  const toggleComparison = useCallback(() => {
    if (comparison.comparing) comparison.leaveComparison();
    else {
      comparison.enterComparison(selection.deviceId);
      setDevicesOpen(true);
    }
  }, [comparison, selection.deviceId]);
  const resumeLatest = () => {
    const end = Date.now();
    const duration = selectedRange ?? historyRangePresets[1]!.duration;
    setRange({
      start: new Date(end - duration).toISOString(),
      end: new Date(end).toISOString(),
    });
    setSelectedRange(duration);
    setLive(true);
    comparison.clearAnchor();
    history.latest();
  };
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow);
  return (
    <section className="flex h-full min-h-0 flex-col gap-4 [--segmented-accent:var(--color-ink)] [&_button:focus-visible]:outline-1 [&_button:focus-visible]:outline-ink/50">
      <HistoryControls
        queryKey={JSON.stringify([input, history.displayPageKey])}
        history={history}
        range={history.range}
        selectedRange={selectedRange}
        ready={ready}
        hasMatches={!noDevices}
        live={live}
        onResume={resumeLatest}
        onRangeChange={(next, nextLive, selected) => {
          setLive(nextLive);
          setSelectedRange(selected);
          setRange(next);
        }}
      />
      <Group
        className="relative min-h-0 flex-1 bg-white"
        id="device-log-panels"
        orientation={narrow ? "vertical" : "horizontal"}
        disabled={narrow}
      >
        <Panel
          id="device-list"
          defaultSize={narrow ? (devicesOpen ? "50%" : "64px") : "250px"}
          minSize={narrow ? (devicesOpen ? "50%" : "64px") : "200px"}
          maxSize={narrow ? (devicesOpen ? "50%" : "64px") : "380px"}
        >
          <DevicePicker
            selection={selection}
            comparison={comparison}
            loaded={ready || Boolean(history.data)}
            available={allDevices.length > 0}
            open={devicesOpen}
            onOpenChange={setDevicesOpen}
          />
        </Panel>
        {narrow ? null : <ResizeHandle label="调整设备列表宽度" />}
        <Panel id="log-reader" minSize="0px">
          <LogReader
            entries={entries}
            selection={selection}
            comparison={comparison}
            queryKey={history.displayPageKey}
            updating={
              !noDevices &&
              !history.error &&
              history.isPending &&
              Boolean(history.displayData)
            }
            loaded={
              noDevices ||
              Boolean(history.displayData) ||
              Boolean(history.error)
            }
            paused={!live}
            view={
              history.displayInput
                ? history.displayInput.kinds.length === 1
                  ? history.displayInput.kinds[0]!
                  : "all"
                : view
            }
            onViewChange={setView}
            onResume={resumeLatest}
            onToggleComparison={toggleComparison}
            loadingOlder={history.loadingOlder}
            onLoadOlder={() => {
              if (
                !history.hasNext ||
                history.isFetching ||
                history.error ||
                noDevices
              )
                return;
              setLive(false);
              history.loadOlder();
            }}
          />
        </Panel>
      </Group>
    </section>
  );
}
