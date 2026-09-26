import { useAtomValue } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { householdSnapshotAtom } from "./household-state";
import { Button } from "../../components/Button";
import { RequestFeedback } from "../../components/RequestFeedback";
import { useMijia } from "./use-mijia";
import { devicesAtom } from "./state";
import { getSetupHomes } from "./api";

export function HomeSelection() {
  const { state, fetchError, actionError, action, perform, refresh } =
    useMijia();
  const snapshot = useAtomValue(householdSnapshotAtom);
  const projection = snapshot?.projection;
  const household = projection?.household.household;
  const devices = useAtomValue(devicesAtom);
  const preparing = devices.filter(
    (device) => device.spec_status === "loading",
  ).length;
  const failed = devices.filter(
    (device) => device.spec_status === "error",
  ).length;
  const setup =
    household?.home_id === null && state?.account.status === "authenticated";
  const choices = useQuery({
    queryKey: [
      "household-setup",
      snapshot?.scope_epoch,
      household?.cloud_synced_at,
    ],
    queryFn: ({ signal }) => getSetupHomes(signal),
    enabled: setup,
    gcTime: 0,
    retry: false,
  });
  const canAct = !action && state?.account.status === "authenticated";
  const name =
    projection &&
    Object.values(projection.home).find(
      (home) => home.home_id === household?.home_id,
    )?.name;
  return (
    <section
      className="home-selection"
      aria-labelledby="home-selection-title"
      aria-busy={action === "selectHome"}
    >
      <div className="home-selection-row">
        <div>
          <h2 id="home-selection-title">被管理家庭</h2>
          <p id="mijia-home-help">
            {setup
              ? "首次设置后，此实例固定服务所选家庭。"
              : "选错家庭需停止服务、修改绑定后重新启动。"}
          </p>
        </div>
        {setup ? (
          <select
            id="mijia-home"
            value=""
            disabled={!canAct || choices.isPending}
            aria-labelledby="home-selection-title"
            aria-describedby="mijia-home-help"
            onChange={(event) => {
              if (canAct && event.target.value)
                void perform({
                  type: "selectHome",
                  homeId: event.target.value,
                });
            }}
          >
            <option value="" disabled>
              请选择家庭
            </option>
            {choices.data?.items.map((home) => (
              <option key={home.id} value={home.id}>
                {home.name}
                {home.shared ? "（共享）" : ""}
              </option>
            ))}
          </select>
        ) : (
          <span>{name ?? household?.home_id ?? "尚未绑定"}</span>
        )}
      </div>
      {household?.homes.status === "unavailable" ? (
        <p className="notice notice-warning">
          绑定家庭已不可访问，请恢复原账号权限后重试。
        </p>
      ) : null}
      {setup && choices.isError ? (
        <Button disabled={!canAct} onClick={() => void choices.refetch()}>
          重试读取家庭列表
        </Button>
      ) : null}
      {setup && choices.data?.items.length === 0 ? (
        <output>暂无可选家庭，请刷新设备清单。</output>
      ) : null}
      {household?.status === "running" ? (
        <Button
          variant="ghost"
          disabled={!canAct}
          onClick={() =>
            void perform({ type: "refreshDevices", target: "specs" })
          }
        >
          重新获取设备规格
        </Button>
      ) : null}
      {preparing || failed ? (
        <output className="home-selection-status">
          {preparing
            ? `${preparing} 台设备${household?.status === "running" ? "正在准备" : "等待准备"}规格。`
            : ""}
          {failed ? `${failed} 台设备的规格获取失败，可重新获取。` : ""}
        </output>
      ) : null}
      {projection?.projection_health.projection_health.capacity_degraded ? (
        <p className="notice notice-warning">
          家庭数据超出容量限制，保留上次已确认的数据。
        </p>
      ) : null}
      {projection?.projection_health.projection_health.storage_degraded ? (
        <p className="notice notice-warning">
          设备清单缓存保存失败，当前已确认设备仍可使用；后台刷新时重试保存。
        </p>
      ) : null}
      {state?.devices.status === "error" ? (
        <p className="notice notice-error" role="alert">
          {state.devices.error?.message}
        </p>
      ) : null}
      {state?.devices.status === "error" || setup ? (
        <Button
          disabled={!canAct}
          onClick={() => void perform({ type: "refreshDevices" })}
        >
          {action === "refreshDevices" ? "正在获取…" : "刷新设备清单"}
        </Button>
      ) : null}
      <RequestFeedback
        fetchError={fetchError}
        error={actionError}
        refresh={() => refresh()}
      />
    </section>
  );
}
