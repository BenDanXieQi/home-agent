import { RequestFeedback } from "../../components/RequestFeedback";
import { RetryConnectionButton } from "./RetryConnectionButton";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { RefreshCw } from "lucide-react";
import { useMijia } from "./use-mijia";
import { Button } from "../../components/Button";

const DeviceGrid = lazy(() =>
  import("./DeviceGrid").then((module) => ({ default: module.DeviceGrid })),
);
const CameraWall = lazy(() => import("./CameraWall"));

export default function MijiaView({ view }: { view: "devices" | "cameras" }) {
  const {
    state,
    reliable,
    canPlay,
    confirming,
    fetching,
    fetchError,
    actionError,
    action,
    perform,
    refresh,
  } = useMijia();
  const homeName = state?.homes.items.find(
    (home) => home.id === state.homes.selectedHomeId,
  )?.name;
  const count =
    state?.devices.status === "ready"
      ? view === "devices"
        ? state.devices.items.length
        : state.devices.items.filter((device) => device.camera).length
      : null;
  return (
    <>
      <div className="page-toolbar">
        <div className="flex items-center gap-2 text-sm">
          <span>
            {homeName ? `${homeName} · ` : ""}
            {view === "devices" ? "全部设备" : "全部摄像头"}
          </span>
          {count !== null ? <span className="count-badge">{count}</span> : null}
        </div>
        <Button
          disabled={fetching || !!action}
          onClick={() => void perform({ type: "refreshDevices" })}
        >
          <RefreshCw size={13} />
          {action === "refreshDevices"
            ? "刷新中…"
            : view === "devices"
              ? "刷新设备"
              : "刷新摄像头"}
        </Button>
      </div>
      {state && state.homes.status !== "selected" ? (
        <p className="notice notice-warning">
          {state.homes.status === "unavailable"
            ? "所选家庭已不可访问。"
            : "尚未选择要接入的家庭。"}
          <Link to="/settings" className="underline">
            前往设置选择家庭
          </Link>
        </p>
      ) : null}
      <RequestFeedback
        fetchError={fetchError}
        error={actionError}
        refresh={() => void refresh()}
      />
      {state?.devices.status === "error" ? (
        <p className="notice notice-error" role="alert">
          {state.devices.items.length
            ? "设备刷新失败，保留上次读取的列表。"
            : "设备读取失败。"}
          {state.devices.error.message}
        </p>
      ) : null}
      {!state ? (
        <div className="workspace-empty">
          <output>正在读取设备…</output>
        </div>
      ) : state.homes.status !== "selected" ? null : (
        <Suspense
          fallback={
            <output>
              正在打开{view === "devices" ? "设备列表" : "摄像头"}…
            </output>
          }
        >
          {view === "devices" ? (
            <DeviceGrid status={state.devices.status} reliable={reliable} />
          ) : (
            <>
              {state.binding.status === "error" ? (
                <div className="notice notice-error" role="alert">
                  <span>{state.binding.error.message}</span>
                  <RetryConnectionButton disabled={!reliable} />
                </div>
              ) : state.binding.status === "installing" ? (
                <output className="notice">正在连接摄像头服务…</output>
              ) : null}
              <CameraWall
                key={
                  state.account.status === "authenticated"
                    ? state.account.id
                    : state.account.status
                }
                state={state}
                ready={canPlay}
                confirming={confirming}
              />
            </>
          )}
        </Suspense>
      )}
    </>
  );
}
