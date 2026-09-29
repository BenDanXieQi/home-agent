import { useEffect } from "react";
import { useAtomValue, useStore } from "jotai";
import type { DeviceLogSnapshot } from "@home-agent/api/device-logs";
import { deviceLogStateAtom } from "./state";
import { subscribeDeviceLogs } from "./subscription";

export function useDeviceLogs(scope: string) {
  const store = useStore();
  const state = useAtomValue(deviceLogStateAtom);
  useEffect(() => subscribeDeviceLogs(store, scope), [store, scope]);
  return state.scope === scope
    ? state
    : {
        scope,
        data: { run: null, entries: [] } satisfies DeviceLogSnapshot,
        connected: false,
        loaded: false,
      };
}
