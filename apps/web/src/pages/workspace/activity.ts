import { mijiaAccountAtom } from "../../modules/mijia/account";
import { mediaBindingAtom } from "../../modules/playback/state";
import { deviceInventoryAtom } from "../../modules/devices/state";
import { atom } from "jotai";
import {
  backendStatusAtom,
  connectionNoticeAtom,
  checkConnectionsAtom,
  configurationQueryAtom,
  connectionReadinessAtom,
  saveConfigurationAtom,
  servicesQueryAtom,
} from "../../modules/connections/state";
import {
  deviceLogCaptureAtom,
  deviceLogScopeAtom,
  deviceLogStateAtom,
} from "../../modules/device-logs/state";
import { householdAtom } from "../../modules/household/state";
import {
  homeChoicesEnabledAtom,
  homeChoicesQueryAtom,
} from "../../modules/household/selection";
import { loginViewAtom } from "../../modules/mijia/login";
import {
  playbackFailedAtom,
  playbackWaitingAtom,
} from "../../modules/playback/state";
import {
  mijiaActionErrorAtom,
  mijiaCommandSyncPendingAtom,
  mijiaPendingCommandAtom,
} from "../../modules/mijia/commands";
import { householdSyncStatusAtom } from "../../modules/household/sync";
import { deviceCapabilityFailureCountAtom } from "../../modules/devices/state";
import { accountDialogOpenAtom } from "./account-dialog-state";

// Stable presentation values keep irrelevant source updates from repainting the brand.
const activities = {
  idle: { state: "idle", label: "就绪" },
  offline: { state: "offline", label: "本机服务未连接" },
  navigating: { state: "thinking", label: "正在打开页面" },
  checking: { state: "thinking", label: "正在检查服务连接" },
  saving: { state: "thinking", label: "正在保存服务配置" },
  servicesError: { state: "attention", label: "服务连接需要检查" },
  authorizing: { state: "thinking", label: "正在处理米家授权" },
  authorizationError: { state: "attention", label: "米家授权需要处理" },
  scan: { state: "listening", label: "等待扫码确认" },
  synchronizing: { state: "thinking", label: "正在同步家庭信息" },
  devices: { state: "thinking", label: "正在同步设备清单" },
  devicesError: { state: "attention", label: "设备同步需要检查" },
  homeError: { state: "attention", label: "家庭设置需要检查" },
  binding: { state: "thinking", label: "正在绑定家庭" },
  cameras: { state: "thinking", label: "正在连接摄像头画面" },
  camerasError: { state: "attention", label: "有摄像头暂时无法播放" },
  logs: { state: "thinking", label: "正在加载设备日志" },
  reconnectingLogs: { state: "thinking", label: "正在重连日志" },
  capture: { state: "thinking", label: "正在更新日志采集" },
  logsError: { state: "attention", label: "日志采集需要检查" },
  listening: { state: "listening", label: "正在监听设备上报" },
} as const;

/** The router supplies scope; Jotai derives presentation directly from feature owners. */
export function createWorkspaceActivityAtom(path: string, navigating: boolean) {
  return atom((get) => {
    const backend = get(backendStatusAtom);
    if (backend === "unavailable") return activities.offline;
    if (navigating) return activities.navigating;
    const candidates: (typeof activities)[keyof typeof activities][] = [];
    if (get(connectionNoticeAtom).attention)
      candidates.push(activities.servicesError);
    const account = get(mijiaAccountAtom);
    const binding = get(mediaBindingAtom);
    const inventory = get(deviceInventoryAtom);
    const command = get(mijiaPendingCommandAtom);
    const actionError = get(mijiaActionErrorAtom);
    const household = get(householdAtom);
    const authorization =
      get(accountDialogOpenAtom) || account?.status !== "authenticated";

    if (authorization) {
      const login = get(loginViewAtom);
      if (login.busy || login.materialLoading)
        candidates.push(activities.authorizing);
      else if (login.error || login.login?.status === "security_required")
        candidates.push(activities.authorizationError);
      else if (login.login?.status === "pending")
        candidates.push(activities.scan);
    }
    if (command)
      candidates.push(
        command === "selectHome"
          ? activities.binding
          : command === "refreshDevices"
            ? activities.devices
            : activities.authorizing,
      );
    if (
      !household ||
      get(mijiaCommandSyncPendingAtom) ||
      get(householdSyncStatusAtom) !== "synced"
    )
      candidates.push(activities.synchronizing);
    if (
      household?.status === "initializing" &&
      household.sync_status !== "error"
    )
      candidates.push(activities.synchronizing);

    if (path === "/devices" || path === "/cameras") {
      if (inventory?.status === "loading") candidates.push(activities.devices);
      if (
        inventory?.status === "error" ||
        (path === "/devices" && get(deviceCapabilityFailureCountAtom) > 0)
      )
        candidates.push(activities.devicesError);
      if (actionError) candidates.push(activities.homeError);
    }
    if (path === "/cameras") {
      if (binding?.status === "installing" || get(playbackWaitingAtom))
        candidates.push(activities.cameras);
      if (binding?.status === "error" || get(playbackFailedAtom))
        candidates.push(activities.camerasError);
    }
    if (path === "/device-logs") {
      const logs = get(deviceLogStateAtom);
      const capture = get(deviceLogCaptureAtom);
      if (capture.pending) candidates.push(activities.capture);
      else if (logs.scope !== get(deviceLogScopeAtom) || !logs.loaded)
        candidates.push(activities.logs);
      else if (!logs.connected) candidates.push(activities.reconnectingLogs);
      else if (
        capture.status === "error" ||
        logs.data.run?.status === "error" ||
        logs.data.run?.status === "interrupted"
      )
        candidates.push(activities.logsError);
      else if (logs.data.run?.status === "capturing")
        candidates.push(activities.listening);
    }
    if (path === "/settings") {
      const config = get(configurationQueryAtom);
      const services = get(servicesQueryAtom);
      const saving = get(saveConfigurationAtom);
      const check = get(checkConnectionsAtom);
      const readiness = get(connectionReadinessAtom);
      if (saving.isPending) candidates.push(activities.saving);
      else if (
        check.isPending ||
        config.isLoading ||
        services.isLoading ||
        readiness.pending ||
        binding?.status === "installing"
      )
        candidates.push(activities.checking);
      else if (
        !readiness.ready ||
        config.isError ||
        services.isError ||
        saving.isError ||
        check.isError
      )
        candidates.push(activities.servicesError);
      if (get(homeChoicesEnabledAtom)) {
        const choices = get(homeChoicesQueryAtom);
        if (choices.isFetching) candidates.push(activities.synchronizing);
        else if (choices.isError) candidates.push(activities.homeError);
      }
      if (actionError || household?.sync_status === "error")
        candidates.push(activities.homeError);
    }
    return (
      candidates.find((activity) => activity.state === "thinking") ??
      candidates.find((activity) => activity.state === "attention") ??
      candidates.find((activity) => activity.state === "listening") ??
      (backend === "checking" ? activities.checking : activities.idle)
    );
  });
}
