import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  Outlet,
} from "@tanstack/react-router";
import { AccountGate } from "./features/mijia/AccountGate";
const rootRoute = createRootRoute({
  component: Outlet,
  pendingComponent: () => <output>正在打开页面…</output>,
  notFoundComponent: () => (
    <div className="py-20 text-center">
      <h1 className="text-3xl">页面不存在</h1>
      <Link to="/" className="button button-primary mt-6">
        返回设备
      </Link>
    </div>
  ),
  errorComponent: ({ reset }) => (
    <div role="alert" className="notice notice-error">
      页面暂时无法显示。<button onClick={reset}>重试</button>
    </div>
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
  component: lazyRouteComponent(() => import("./pages/DevicesPage")),
});
const camerasRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/cameras",
  component: lazyRouteComponent(() => import("./pages/CamerasPage")),
});
const settingsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("./pages/SettingsPage")),
});
const deviceLogsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/device-logs",
  component: lazyRouteComponent(() => import("./pages/DeviceLogsPage")),
});
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    accountRoute.addChildren([
      indexRoute,
      devicesRoute,
      camerasRoute,
      deviceLogsRoute,
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
