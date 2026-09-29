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
        返回设备
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
const indexRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/",
});
const devicesRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/devices",
  component: lazyRouteComponent(() => import("./pages/devices/index")),
});
const camerasRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/cameras",
  component: lazyRouteComponent(() => import("./pages/cameras/index")),
});
const settingsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("./pages/settings/index")),
});
const roomsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/rooms",
  component: lazyRouteComponent(() => import("./pages/rooms/index")),
});
const deviceLogsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/device-logs",
  component: lazyRouteComponent(() => import("./pages/device-logs/index")),
});
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    accountRoute.addChildren([
      indexRoute,
      devicesRoute,
      camerasRoute,
      deviceLogsRoute,
      roomsRoute,
      settingsRoute,
    ]),
  ]),
  scrollRestoration: true,
  defaultPreload: "intent",
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
