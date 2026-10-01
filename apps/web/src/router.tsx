import { buttonStyles } from "./components/button-styles";
import { Notice } from "./components/Notice";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  Outlet,
} from "@tanstack/react-router";
import { AccountGate } from "./pages/workspace/AccountGate";
import WorkspaceLayout from "./pages/workspace/index";
const rootRoute = createRootRoute({
  component: Outlet,
  pendingComponent: () => <output>正在打开页面…</output>,
  notFoundComponent: () => (
    <div className="py-20 text-center">
      <h1 className="text-3xl">页面不存在</h1>
      <Link
        draggable={false}
        to="/"
        className={`${buttonStyles.base} ${buttonStyles.primary} hover:bg-ink/85 mt-6`}
      >
        返回房间
      </Link>
    </div>
  ),
  errorComponent: ({ reset }) => (
    <Notice tone="error">
      页面暂时无法显示。<button onClick={reset}>重试</button>
    </Notice>
  ),
});
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "account",
  component: AccountGate,
});
const publicWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "public-workspace",
  component: WorkspaceLayout,
});
const indexRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/",
});
const devicesRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/devices",
  component: lazyRouteComponent(() => import("./pages/devices/index")),
});
const membersRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/members",
  validateSearch: (search: Record<string, unknown>) => ({
    member: typeof search.member === "string" ? search.member : undefined,
  }),
  component: lazyRouteComponent(() => import("./pages/members/index")),
});
const addMemberRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/members/new",
  component: lazyRouteComponent(() => import("./pages/members/AddMemberPage")),
});
const camerasRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/cameras",
  component: lazyRouteComponent(() => import("./pages/cameras/CameraLayout")),
});
const camerasIndexRoute = createRoute({
  getParentRoute: () => camerasRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./pages/cameras/index")),
});
const cameraDetailRoute = createRoute({
  getParentRoute: () => camerasRoute,
  path: "$deviceId/$channel",
  component: lazyRouteComponent(() => import("./pages/cameras/CameraDetail")),
});
const imageAnalysisRoute = createRoute({
  getParentRoute: () => publicWorkspaceRoute,
  path: "/cameras/images",
  component: lazyRouteComponent(() => import("./pages/cameras/ImageAnalysis")),
});
const settingsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("./pages/settings/index")),
});
const deviceLogsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/device-logs",
  staticData: { contentLayout: "viewport" },
  component: lazyRouteComponent(() => import("./pages/device-logs/index")),
});
const dataRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/data",
  component: lazyRouteComponent(() => import("./pages/database/index")),
});
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    accountRoute.addChildren([
      indexRoute,
      devicesRoute,
      membersRoute,
      addMemberRoute,
      camerasRoute.addChildren([camerasIndexRoute, cameraDetailRoute]),
      deviceLogsRoute,
      dataRoute,
      settingsRoute,
    ]),
    publicWorkspaceRoute.addChildren([imageAnalysisRoute]),
  ]),
  scrollRestoration: true,
  getScrollRestorationKey: (location) => location.href,
  defaultPreload: "intent",
});
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    contentLayout?: "viewport";
  }
  interface Register {
    router: typeof router;
  }
}
