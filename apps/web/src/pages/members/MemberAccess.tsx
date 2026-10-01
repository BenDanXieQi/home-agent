import type { ReactNode } from "react";
import { useAtomValue } from "jotai";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
} from "../../modules/household/state";
import { HouseholdAccess } from "../../modules/household/HouseholdAccess";
import { Notice } from "../../components/Notice";

export function MemberAccess({
  children,
}: {
  children: (scope: string) => ReactNode;
}) {
  const snapshot = useAtomValue(householdSnapshotAtom);
  const synced = useAtomValue(householdSyncedAtom);
  return (
    <HouseholdAccess fallback={<Notice>正在读取家庭状态…</Notice>}>
      {snapshot &&
      synced &&
      snapshot.projection.household.household.status === "running" ? (
        children(snapshot.scope_epoch)
      ) : (
        <Notice>家庭连接就绪后可管理成员。</Notice>
      )}
    </HouseholdAccess>
  );
}
