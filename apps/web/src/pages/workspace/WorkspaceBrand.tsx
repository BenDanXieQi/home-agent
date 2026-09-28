import { workspaceBrandClassName } from "./workspace-styles";
import { useAtomValue } from "jotai";
import { useRouterState } from "@tanstack/react-router";
import { Popover } from "radix-ui";
import { connectionNoticeAtom } from "../../modules/connections/state";
import { ConnectionNotice } from "./ConnectionNotice";
import { AgentAvatar } from "../../components/AgentAvatar";
import { createWorkspaceActivityAtom } from "./activity";
import { useMemo } from "react";

export function WorkspaceBrand() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const navigating = useRouterState({
    select: (state) => state.status === "pending",
  });
  const activityAtom = useMemo(
    () => createWorkspaceActivityAtom(path, navigating),
    [path, navigating],
  );
  const activity = useAtomValue(activityAtom);
  const notice = useAtomValue(connectionNoticeAtom);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={workspaceBrandClassName}
          aria-label={`Home Agent，${activity.label}${notice.attention ? `，${notice.title}` : ""}，查看连接状态`}
          title={notice.attention ? notice.title : activity.label}
        >
          <AgentAvatar state={activity.state} />
          {notice.attention ? (
            <span
              className="absolute right-3 top-4 size-1.5 rounded-full bg-amber-500"
              aria-hidden="true"
            />
          ) : null}
        </button>
      </Popover.Trigger>
      <output className="sr-only" aria-live="polite" aria-atomic="true">
        {notice.attention ? notice.title : ""}
      </output>
      <ConnectionNotice />
    </Popover.Root>
  );
}
