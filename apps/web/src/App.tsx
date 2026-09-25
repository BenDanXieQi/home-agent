import { useEffect, lazy, Suspense } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  LayoutGrid,
  Video,
  Settings2,
  House,
  UserRound,
  ChevronRight,
  PanelLeft,
} from "lucide-react";
import { m } from "motion/react";
import { Dialog } from "radix-ui";
import { mijiaFetchErrorAtom } from "./features/mijia/state";
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
  { to: "/settings", label: "服务设置", icon: Settings2 },
] as const;
export default function App() {
  const [loginOpen, openLogin] = useAtom(accountDialogOpenAtom);
  const path = useRouterState({ select: (state) => state.location.pathname });
  const current = navigation.find((item) => item.to === path);
  const fetchError = useAtomValue(mijiaFetchErrorAtom);
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
            {navigation.map(({ to, label, icon: Icon }, index) => (
              <Link
                key={to}
                to={to}
                aria-label={label}
                activeOptions={{ exact: true }}
                onClick={() => setExpanded(false)}
                className={`workspace-nav-item ${index === 2 ? "nav-settings" : ""}`}
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
                aria-label="米家账号，已登录"
              >
                <span className="account-avatar">
                  <UserRound size={17} />
                </span>
                <span className="account-copy">
                  <strong>米家账号</strong>
                  <span>{fetchError ? "状态不可用" : "已登录"}</span>
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
