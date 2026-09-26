import { Button } from "../../components/Button";
import { RequestFeedback } from "../../components/RequestFeedback";
import { useMijia } from "./use-mijia";

export function HomeSelection() {
  const { state, reliable, fetching, fetchError, action, perform, refresh } =
    useMijia();
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
          <h2 id="home-selection-title">米家家庭</h2>
          <p id="mijia-home-help">仅接入所选家庭的设备，修改后自动保存。</p>
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
              accountId: state.account.id,
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
            <option key={home.id} value={home.id} disabled={!catalogReady}>
              {home.name}
              {home.shared ? "（共享）" : ""}
            </option>
          ))}
        </select>
      </div>
      {statusMessage ? (
        <output className="home-selection-status">{statusMessage}</output>
      ) : null}
      {state?.devices.status === "error" ? (
        <p className="notice notice-error" role="alert">
          {state.devices.error.message}
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
      <RequestFeedback fetchError={fetchError} refresh={() => void refresh()} />
    </section>
  );
}
