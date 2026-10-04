import type { ReactNode } from "react";
import { useAtomValue } from "jotai";
import { memberScopeAtom } from "../../modules/members/state";
import { HouseholdAccess } from "../../modules/household/HouseholdAccess";
import { Notice } from "../../components/Notice";

export function MemberAccess({
  children,
}: {
  children: (scope: string) => ReactNode;
}) {
  const scope = useAtomValue(memberScopeAtom);
  return (
    <HouseholdAccess fallback={<Notice>正在读取家庭状态…</Notice>}>
      {scope ? children(scope) : <Notice>家庭连接就绪后可管理成员。</Notice>}
    </HouseholdAccess>
  );
}
