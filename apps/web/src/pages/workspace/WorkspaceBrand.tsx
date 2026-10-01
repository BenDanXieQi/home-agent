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
    <>
      {notice.attention ? (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              className={`${workspaceBrandClassName} cursor-pointer`}
              aria-label={`Home Agent，${activity.label}，${notice.title}，查看连接问题`}
              title={notice.title}
            >
              <AgentAvatar state={activity.state} />
              <span
                className="absolute right-3 top-4 size-1.5 rounded-full bg-amber-500"
                aria-hidden="true"
              />
            </button>
          </Popover.Trigger>
          <ConnectionNotice />
        </Popover.Root>
      ) : (
        <div
          className={workspaceBrandClassName}
          title={activity.label}
        >
          <span className="sr-only">Home Agent，{activity.label}</span>
          <AgentAvatar state={activity.state} />
        </div>
      )}
      <output className="sr-only" aria-live="polite" aria-atomic="true">
        {notice.attention ? notice.title : ""}
      </output>
    </>
  );
}
