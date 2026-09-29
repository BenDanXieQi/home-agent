import { useAtomValue } from "jotai";
import { Dialog } from "radix-ui";
import { WorkspaceBrand } from "./WorkspaceBrand";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { SidebarFrame } from "./WorkspaceFrame";
import { workspaceAccountClassName } from "./workspace-styles";
import { AccountAvatar } from "../../modules/mijia/AccountAvatar";
import { mijiaAccountAtom } from "../../modules/mijia/account";
import { mijiaAccountLabelAtom } from "../../modules/mijia/login";
import { deviceCapabilityFailureCountAtom } from "../../modules/devices/state";
export function WorkspaceSidebar({ path }: { path: string }) {
  const capabilityFailures = useAtomValue(deviceCapabilityFailureCountAtom);
  const accountLabel = useAtomValue(mijiaAccountLabelAtom);
  const account = useAtomValue(mijiaAccountAtom);
  const accountName =
    (account?.status === "authenticated" && account.profile?.name) ||
    "米家账号";
  return (
    <SidebarFrame
      brand={<WorkspaceBrand />}
      account={
        <Dialog.Trigger asChild>
          <button
            type="button"
            className={workspaceAccountClassName}
            aria-label={`账户，${accountName}，${accountLabel}`}
          >
            <AccountAvatar />
            <span className="whitespace-nowrap max-md:hidden">账户</span>
          </button>
        </Dialog.Trigger>
      }
    >
      <WorkspaceNavigation
        path={path}
        capabilityFailures={capabilityFailures}
      />
    </SidebarFrame>
  );
}
