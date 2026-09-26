import { useEffect, lazy, Suspense } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  LayoutGrid,
  Video,
  ScrollText,
  Settings2,
  House,
  ChevronRight,
  PanelLeft,
} from "lucide-react";
import { m } from "motion/react";
import { Dialog } from "radix-ui";
import { AccountAvatar } from "./features/mijia/AccountAvatar";
import {
  mijiaAccountAtom,
  mijiaAccountLabelAtom,
} from "./features/mijia/state";
import { accountDialogOpenAtom, navigationOpenAtom } from "./state/ui";
import { BackendStatus } from "./features/connections/BackendStatus";
const ConnectionNotice = lazy(() =>
  import("./features/connections/ConnectionNotice").then((module) => ({
    default: module.ConnectionNotice,
  })),
);
const AccountDialog = lazy(() => import("./features/mijia/AccountDialog"));

const navigation = [
  { to: "/devices", label: "设备", icon: LayoutGrid },
  { to: "/cameras", label: "摄像头", icon: Video },
  { to: "/device-logs", label: "设备日志", icon: ScrollText },
  { to: "/settings", label: "设置", icon: Settings2 },
] as const;
export default function App() {
  const [loginOpen, openLogin] = useAtom(accountDialogOpenAtom);
  const path = useRouterState({ select: (state) => state.location.pathname });
  const current = navigation.find((item) => item.to === path);
  const accountLabel = useAtomValue(mijiaAccountLabelAtom);
  const account = useAtomValue(mijiaAccountAtom);
  const accountName =
    (account?.status === "authenticated" && account.profile?.name) ||
    "米家账号";
  const expanded = useAtomValue(navigationOpenAtom);
  const setExpanded = useSetAtom(navigationOpenAtom);
  useEffect(() => {
    document.title = `${current?.label ?? "Home Agent"} · Home Agent`;
  }, [current?.label]);
  return (
    <Dialog.Root open={loginOpen} onOpenChange={openLogin}>
      <div className={`workspace ${expanded ? "navigation-expanded" : ""}`}>
        <a className="skip-link" href="#main-content">
          跳到主内容
        </a>
        <aside className="workspace-sidebar">
          <Link
            to="/devices"
            className="workspace-brand"
            aria-label="Home Agent"
          >
            <House size={21} strokeWidth={1.7} />
            <span>Home Agent</span>
          </Link>
          <nav
            id="workspace-navigation"
            className="workspace-nav"
            aria-label="工作台导航"
          >
            {navigation.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                aria-label={label}
                activeOptions={{ exact: true }}
                onClick={() => setExpanded(false)}
                className={`workspace-nav-item ${to === "/settings" ? "nav-settings" : ""}`}
                activeProps={{ className: "is-active" }}
              >
                <Icon size={18} strokeWidth={1.65} />
                <span>{label}</span>
              </Link>
            ))}
          </nav>
          <div className="sidebar-account">
            <Dialog.Trigger asChild>
              <button
                type="button"
                className="account-button"
                aria-label={`${accountName}，${accountLabel}`}
              >
                <AccountAvatar />
                <span className="account-copy">
                  <strong title={accountName}>{accountName}</strong>
                  <span>{accountLabel}</span>
                </span>
                <ChevronRight size={13} />
              </button>
            </Dialog.Trigger>
          </div>
        </aside>
        <div className="workspace-main">
          <header className="workspace-topbar">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="mobile-navigation"
                aria-label="切换导航"
                aria-expanded={expanded}
                aria-controls="workspace-navigation"
                onClick={() => setExpanded(!expanded)}
              >
                <PanelLeft size={18} />
              </button>
              <h1>{current?.label ?? "Home Agent"}</h1>
            </div>
            <BackendStatus />
          </header>
          <main id="main-content" tabIndex={-1} className="workspace-content">
            <m.div
              key={path}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.12 }}
              className="workspace-page"
            >
              <Outlet />
            </m.div>
          </main>
        </div>
        {path !== "/settings" ? (
          <Suspense fallback={null}>
            <ConnectionNotice />
          </Suspense>
        ) : null}
        {loginOpen ? (
          <Suspense fallback={null}>
            <AccountDialog />
          </Suspense>
        ) : null}
      </div>
    </Dialog.Root>
  );
}
