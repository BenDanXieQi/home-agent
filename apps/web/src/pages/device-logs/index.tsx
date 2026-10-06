import { Activity } from "lucide-react";
import { useAtomValue } from "jotai";
import {
  householdAtom,
  householdScopeEpochAtom,
  householdSyncedAtom,
} from "../../modules/household/state";
import { EmptyState } from "../../components/EmptyState";
import { DeviceLogWorkspace } from "./DeviceLogWorkspace";

export default function DeviceLogsPage() {
  const household = useAtomValue(householdAtom);
  const scope = useAtomValue(householdScopeEpochAtom);
  const synced = useAtomValue(householdSyncedAtom);
  if (!household?.account_id || !household.home_id || !scope)
    return (
      <EmptyState
        icon={<Activity size={24} />}
        title="等待家庭连接"
        description="绑定家庭后即可查询设备历史。"
      />
    );
  return (
    <DeviceLogWorkspace
      key={scope}
      scope={scope}
      accountId={household.account_id}
      homeId={household.home_id}
      ready={synced && household.status === "running"}
    />
  );
}
