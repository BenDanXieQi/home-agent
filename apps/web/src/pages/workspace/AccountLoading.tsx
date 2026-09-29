import { WorkspaceFrame, SidebarFrame } from "./WorkspaceFrame";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import {
  workspaceAccountClassName,
  workspaceBrandClassName,
} from "./workspace-styles";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Skeleton } from "../../components/Skeleton";

export function AccountLoading({ path }: { path: string }) {
  return (
    <WorkspaceFrame
      sidebar={
        <SidebarFrame
          brand={
            <span
              className={workspaceBrandClassName}
              aria-label="Home Agent，正在读取账号状态"
            >
              <AgentAvatar state="thinking" />
            </span>
          }
          account={
            <span className={workspaceAccountClassName}>
              <Skeleton className="size-8 rounded-full" />
              <span className="whitespace-nowrap max-md:hidden">
                <Skeleton className="my-[0.2lh] h-[0.6lh] w-16" />
              </span>
            </span>
          }
        >
          <WorkspaceNavigation path={path} loading />
        </SidebarFrame>
      }
      header={
        <WorkspaceHeader path={path}>
          <output className="sr-only">正在读取账号状态…</output>
        </WorkspaceHeader>
      }
    />
  );
}
