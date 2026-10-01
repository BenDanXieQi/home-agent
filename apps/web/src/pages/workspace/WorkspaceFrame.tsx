import type { ReactNode } from "react";

/** Shared geometry for the loading shell and the signed-in workspace. */
export function WorkspaceFrame({
  sidebar,
  header,
  children,
  contained = false,
}: {
  sidebar: ReactNode;
  header: ReactNode;
  children?: ReactNode;
  contained?: boolean;
}) {
  return (
    <div
      className={contained ? "flex h-dvh overflow-hidden" : "flex min-h-dvh"}
    >
      {sidebar}
      <div
        className={`min-w-0 flex-1 pl-[112px] max-md:pl-0 max-md:pb-[calc(76px_+_env(safe-area-inset-bottom))] ${contained ? "flex min-h-0 flex-col overflow-hidden" : ""}`}
      >
        {header}
        {children}
      </div>
    </div>
  );
}
export function SidebarFrame({
  brand,
  account,
  children,
}: {
  brand: ReactNode;
  account: ReactNode;
  children: ReactNode;
}) {
  return (
    <aside className="fixed inset-y-3 left-3 z-20 flex w-[100px] flex-col bg-white select-none [&_img]:[-webkit-user-drag:none] max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:w-auto max-md:flex-row max-md:items-center max-md:px-2 max-md:shadow-[0_-4px_20px_#00000008] max-md:pb-[env(safe-area-inset-bottom)]">
      {brand}
      <nav
        id="workspace-navigation"
        className="relative isolate flex min-w-0 flex-1 flex-col gap-2 px-2 pt-2 max-md:flex-row max-md:gap-1 max-md:p-2"
        aria-label="工作台导航"
      >
        {children}
      </nav>
      <div className="mx-2 mb-2 flex shrink-0 items-center max-md:hidden">
        {account}
      </div>
    </aside>
  );
}
