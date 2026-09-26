import { useAtomValue } from "jotai";
import { householdSnapshotAtom } from "./household-state";
import { Button } from "../../components/Button";
import { RequestFeedback } from "../../components/RequestFeedback";
import { useMijia } from "./use-mijia";

export function HomeSelection() {
  const { state, reliable, fetching, fetchError, action, perform, refresh } =
    useMijia();
  const projection = useAtomValue(householdSnapshotAtom)?.projection;
  const household = projection?.household.household;
  const specifications = Object.values(projection?.spec ?? {});
  const preparing = specifications.filter(
    (spec) => spec.status === "loading",
  ).length;
  const failed = specifications.filter(
    (spec) => spec.status === "error",
  ).length;
  const homes = state?.homes;
  const saving = action === "selectHome";
  const catalogReady = state?.devices.status === "ready";
  const canEdit =
    reliable && !action && state?.account.status === "authenticated";
  const statusMessage = saving
    ? "正在保存…"
    : !homes
      ? "正在读取…"
      : homes.status === "unavailable"
        ? "家庭已不可访问，请重新选择。"
        : catalogReady && homes.items.length === 0
          ? "暂无可选家庭。"
          : null;
  return (
    <section
      className="home-selection"
      aria-labelledby="home-selection-title"
      aria-busy={saving}
    >
      <div className="home-selection-row">
        <div>
          <h2 id="home-selection-title">被管理家庭</h2>
          <p id="mijia-home-help">更换家庭会停止旧家庭的任务和观看。</p>
        </div>
        <select
          id="mijia-home"
          value={homes?.selectedHomeId ?? ""}
          disabled={!canEdit}
          aria-labelledby="home-selection-title"
          aria-describedby="mijia-home-help"
          onChange={(event) => {
            if (!canEdit || state?.account.status !== "authenticated") return;
            void perform({
              type: "selectHome",
              homeId: event.target.value || null,
            });
          }}
        >
          <option value="">不接入任何家庭</option>
          {homes?.status === "unavailable" ? (
            <option value={homes.selectedHomeId ?? ""} disabled>
              原家庭已不可访问
            </option>
          ) : null}
          {homes?.items.map((home) => (
            <option key={home.id} value={home.id} disabled={false}>
              {home.name}
              {home.shared ? "（共享）" : ""}
            </option>
          ))}
        </select>
      </div>
      {household?.status === "initializing" &&
      household.sync_status === "error" ? (
        <Button
          disabled={!canEdit}
          onClick={() =>
            void perform({ type: "selectHome", homeId: household.home_id })
          }
        >
          重试初始化
        </Button>
      ) : null}
      {household?.status === "running" ? (
        <Button
          variant="ghost"
          disabled={!canEdit}
          onClick={() =>
            void perform({ type: "refreshDevices", target: "specs" })
          }
        >
          重新获取设备规格
        </Button>
      ) : null}
      {preparing || failed ? (
        <output className="home-selection-status">
          {preparing ? `${preparing} 份设备规格正在准备。` : ""}
          {failed ? `${failed} 份设备规格获取失败，可重新获取。` : ""}
        </output>
      ) : null}
      {projection?.projection_health.projection_health.capacity_degraded ? (
        <p className="notice notice-warning">
          家庭数据超出容量限制，保留上次已确认的数据。
        </p>
      ) : null}
      {statusMessage ? (
        <output className="home-selection-status">{statusMessage}</output>
      ) : null}
      {state?.devices.status === "error" ? (
        <p className="notice notice-error" role="alert">
          {state.devices.error?.message}
        </p>
      ) : null}
      {state?.devices.status === "error" ||
      (catalogReady && homes?.items.length === 0) ? (
        <Button
          disabled={!reliable || !!action || fetching}
          onClick={() => void perform({ type: "refreshDevices" })}
        >
          {action === "refreshDevices"
            ? "正在获取…"
            : state?.devices.status === "error"
              ? "重试"
              : "重新获取"}
        </Button>
      ) : null}
      <RequestFeedback fetchError={fetchError} refresh={() => refresh()} />
    </section>
  );
}
