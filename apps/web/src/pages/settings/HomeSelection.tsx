import { Notice } from "../../components/Notice";
import { useEffect, useState } from "react";
import { House, ArrowLeftRight } from "lucide-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { householdSnapshotAtom } from "../../modules/household/state";
import { Button } from "../../components/Button";
import { Select } from "../../components/Select";
import { RequestFeedback } from "../../components/RequestFeedback";
import { mijiaAccountAtom } from "../../modules/mijia/account";
import {
  mijiaActionErrorAtom,
  performMijiaAtom,
} from "../../modules/mijia/commands";
import { householdSyncMessageAtom } from "../../modules/household/sync";
import { reconnectHouseholdAtom } from "../../modules/household/state";
import { deviceInventoryAtom } from "../../modules/devices/state";
import { mijiaCommandOutcomeAtom } from "../../modules/mijia/commands";
import {
  editingHomeScopeAtom,
  homeChoicesQueryAtom,
} from "../../modules/household/selection";
import { requestErrorMessage } from "../../messages/zh-CN";

export function HomeSelection() {
  const account = useAtomValue(mijiaAccountAtom);
  const inventory = useAtomValue(deviceInventoryAtom);
  const syncMessage = useAtomValue(householdSyncMessageAtom);
  const actionError = useAtomValue(mijiaActionErrorAtom);
  const perform = useSetAtom(performMijiaAtom);
  const refresh = useSetAtom(reconnectHouseholdAtom);
  const snapshot = useAtomValue(householdSnapshotAtom);
  const outcome = useAtomValue(mijiaCommandOutcomeAtom);
  const action = outcome.status === "pending" ? outcome.type : null;
  const [editingScope, setEditingScope] = useAtom(editingHomeScopeAtom);
  useEffect(() => () => setEditingScope(null), [setEditingScope]);
  const [targetHome, setTargetHome] = useState("");
  const editing =
    editingScope !== null && editingScope === snapshot?.scope_epoch;
  const refreshStatus =
    outcome.type === "refreshDevices" ? outcome.status : "idle";
  const projection = snapshot?.projection;
  const household = projection?.household.household;
  const setup =
    household?.home_id === null && account?.status === "authenticated";
  const choices = useAtomValue(homeChoicesQueryAtom);
  const canAct =
    !action && Boolean(snapshot) && account?.status === "authenticated";
  const availableHomes = (choices.data?.items ?? []).filter(
    (home) => home.id !== household?.home_id,
  );
  const target = availableHomes.find((home) => home.id === targetHome);
  const name =
    projection &&
    Object.values(projection.home).find(
      (home) => home.home_id === household?.home_id,
    )?.name;
  return (
    <section
      className="mb-6 w-full rounded-2xl bg-white p-6 shadow-panel [&_>_h2]:text-base [&_>_h2]:font-semibold"
      aria-labelledby="home-selection-title"
      aria-busy={action === "selectHome"}
    >
      <h2 id="home-selection-title">米家家庭</h2>
      {setup ? (
        <p className="mt-2 text-sm text-muted">选择要管理的家庭。</p>
      ) : (
        <div className="mt-5 flex items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface text-ink"
            aria-hidden="true"
          >
            <House size={22} strokeWidth={1.7} />
          </span>
          <div className="min-w-0">
            <span className="text-xs text-muted">已绑定家庭</span>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
              <strong className="break-words text-xl font-semibold leading-7 tracking-tight text-ink wrap-anywhere">
                {name ?? (household?.home_id ? "家庭信息加载中" : "尚未绑定")}
              </strong>
              {household?.home_id ? (
                <Button
                  variant="ghost"
                  className={`h-9 shrink-0 py-0 text-xs${editing ? " invisible" : ""}`}
                  aria-label="重新绑定家庭"
                  aria-hidden={editing || undefined}
                  disabled={!canAct || editing}
                  onClick={() => {
                    setTargetHome("");
                    setEditingScope(snapshot?.scope_epoch ?? null);
                  }}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <ArrowLeftRight size={14} aria-hidden="true" />
                    重新绑定
                  </span>
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      )}
      {setup || editing ? (
        <div className="mt-5 flex w-full max-w-lg flex-col items-start gap-3 rounded-xl bg-surface/60 p-4">
          <Select
            label="要绑定的家庭"
            placeholder={choices.isPending ? "正在读取家庭…" : "请选择家庭"}
            className="h-9 text-sm"
            value={targetHome}
            disabled={!canAct || choices.isPending}
            onValueChange={setTargetHome}
            options={availableHomes.map((home) => ({
              value: home.id,
              label: `${home.name}${home.shared ? "（共享）" : ""}`,
            }))}
          />
          {editing ? (
            <p className="text-sm text-muted" id="home-binding-impact">
              {target
                ? `确认将管理的家庭改为“${target.name}”？`
                : "请选择要重新绑定的家庭。"}
              重新绑定会停止当前家庭的设备任务和视频连接，再加载新家庭的设备。
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="h-9 py-0"
              disabled={!canAct || !target}
              aria-describedby={editing ? "home-binding-impact" : undefined}
              status={action === "selectHome" ? "pending" : "idle"}
              onClick={() => {
                if (canAct && target)
                  void perform({ type: "selectHome", homeId: target.id });
              }}
            >
              {action === "selectHome"
                ? "正在保存…"
                : editing
                  ? "确认重新绑定"
                  : "绑定家庭"}
            </Button>
            {editing ? (
              <Button
                className="h-9 py-0"
                disabled={action === "selectHome"}
                onClick={() => setEditingScope(null)}
              >
                取消
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {household?.homes.status === "unavailable" ? (
        <Notice tone="warning">
          绑定家庭已不可访问，请恢复原账号权限后重试，或重新绑定其他家庭。
        </Notice>
      ) : null}
      {(setup || editing) && choices.isError ? (
        <Button
          disabled={!canAct || choices.isFetching}
          status={
            choices.isFetching
              ? "pending"
              : choices.isError
                ? "error"
                : "success"
          }
          onClick={() => void choices.refetch()}
        >
          重试读取家庭列表
        </Button>
      ) : null}
      {(setup || editing) &&
      choices.isSuccess &&
      availableHomes.length === 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
          <output>暂无其他可选家庭。</output>
          <Button
            disabled={!canAct || choices.isFetching}
            status={choices.isFetching ? "pending" : "idle"}
            onClick={() => void choices.refetch()}
          >
            重新读取家庭列表
          </Button>
        </div>
      ) : null}
      {household?.status === "initializing" ? (
        <output className="mt-3 block text-sm text-muted">
          正在加载已绑定家庭的设备清单；加载失败后可刷新重试。
        </output>
      ) : null}
      {projection?.projection_health.projection_health.capacity_degraded ? (
        <Notice tone="warning">
          家庭数据超出容量限制，保留上次已确认的数据。
        </Notice>
      ) : null}
      {projection?.projection_health.projection_health.storage_degraded ? (
        <Notice tone="warning">
          设备清单缓存保存失败，当前已确认设备仍可使用；后台刷新时重试保存。
        </Notice>
      ) : null}
      {inventory?.status === "error" ? (
        <Notice tone="error">{inventory.error?.message}</Notice>
      ) : null}
      {!setup && !editing && inventory?.status === "error" ? (
        <Button
          disabled={!canAct}
          status={refreshStatus}
          onClick={() => void perform({ type: "refreshDevices" })}
        >
          {action === "refreshDevices" ? "正在获取…" : "刷新设备清单"}
        </Button>
      ) : null}
      <RequestFeedback
        syncMessage={syncMessage}
        error={
          actionError ??
          ((setup || editing) && choices.isError
            ? requestErrorMessage(choices.error)
            : null)
        }
        refresh={() => refresh()}
      />
    </section>
  );
}
