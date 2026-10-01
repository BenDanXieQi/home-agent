import { useMobileWorkspace } from "./use-mobile-workspace";
import { WorkspaceBrand } from "./WorkspaceBrand";
import { WorkspaceFrame } from "./WorkspaceFrame";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Outlet, useMatches, useRouterState } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { AnimatePresence, useReducedMotion } from "motion/react";
import { Dialog } from "radix-ui";
import { navigation } from "../../navigation";
import { PageHeaderContext } from "../../components/page-header-context";
import { accountDialogOpenAtom } from "./account-dialog-state";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { WorkspaceHeader } from "./WorkspaceHeader";
// Keep the dialog eager so the first open can animate immediately.
import AccountDialog from "./AccountDialog";

export default function WorkspaceLayout() {
  const mobile = useMobileWorkspace();
  const [headerDetails, setHeaderDetails] = useState<HTMLDivElement | null>(
    null,
  );
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(
    null,
  );
  const [loginOpen, openLogin] = useAtom(accountDialogOpenAtom);
  const path = useRouterState({ select: (state) => state.location.pathname });
  const contained = useMatches({
    select: (matches) =>
      matches.some((match) => match.staticData.contentLayout === "viewport"),
  });
  const current = navigation.find(
    (item) => item.to === path || path.startsWith(`${item.to}/`),
  );
  const page = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const headerSlots = useMemo(
    () => ({ details: headerDetails, actions: headerActions }),
    [headerDetails, headerActions],
  );
  useLayoutEffect(() => {
    if (reducedMotion) return undefined;
    const animation = page.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 260,
      easing: "cubic-bezier(0, 0, 0.58, 1)",
    });
    return () => animation?.cancel();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A committed route change replays the page entrance without remounting it.
    path,
    reducedMotion,
  ]);
  useEffect(() => {
    document.title = `${current?.label ?? "Home Agent"} · Home Agent`;
  }, [current?.label]);
  return (
    <Dialog.Root open={loginOpen} onOpenChange={openLogin}>
      <>
        <a
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-white focus:p-3"
          href="#main-content"
        >
          跳到主内容
        </a>
        <WorkspaceFrame
          contained={contained}
          sidebar={
            <WorkspaceSidebar
              path={path}
              mobile={mobile}
              brand={mobile ? null : <WorkspaceBrand />}
            />
          }
          header={
            <WorkspaceHeader
              path={path}
              brand={mobile ? <WorkspaceBrand /> : null}
              detailsRef={setHeaderDetails}
              actionsRef={setHeaderActions}
            />
          }
        >
          <main
            id="main-content"
            tabIndex={-1}
            className={`px-4 pb-6 ${contained ? "min-h-0 flex-1" : ""}`}
          >
            {/* The router owns page lifetimes; animating must not remount its outlet. */}
            <div
              ref={page}
              className={
                contained ? "h-full min-h-0" : "min-h-[calc(100dvh-90px)]"
              }
            >
              <PageHeaderContext value={headerSlots}>
                <Outlet />
              </PageHeaderContext>
            </div>
          </main>
        </WorkspaceFrame>
        <AnimatePresence>
          {loginOpen ? <AccountDialog key="account" /> : null}
        </AnimatePresence>
      </>
    </Dialog.Root>
  );
}
