import { BackLink } from "./components/BackLink";
import { Notice } from "./components/Notice";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
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
      <BackLink activeOptions={{ exact: true }} to="/devices" className="mt-6">
        返回房间
      </BackLink>
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
const agentRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/agent",
  staticData: { contentLayout: "viewport" },
  component: lazyRouteComponent(() => import("./pages/agent/index")),
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
  validateSearch: (search: Record<string, unknown>) => ({
    mode: search.mode === "windows" ? search.mode : undefined,
    activityRun:
      typeof search.activityRun === "string" ? search.activityRun : undefined,
    member: typeof search.member === "string" ? search.member : undefined,
    activityFirstAt:
      typeof search.activityFirstAt === "number" &&
      Number.isFinite(search.activityFirstAt)
        ? search.activityFirstAt
        : undefined,
    activityAt:
      typeof search.activityAt === "number" &&
      Number.isFinite(search.activityAt)
        ? search.activityAt
        : undefined,
  }),
  component: lazyRouteComponent(() => import("./pages/cameras/CameraDetail")),
});
const cameraRecordingRoute = createRoute({
  getParentRoute: () => camerasRoute,
  path: "$deviceId/$channel/recording",
  validateSearch: (search: Record<string, unknown>) => ({
    member: typeof search.member === "string" ? search.member : undefined,
    activityRun:
      typeof search.activityRun === "string" ? search.activityRun : undefined,
    activityFirstAt:
      typeof search.activityFirstAt === "number" &&
      Number.isFinite(search.activityFirstAt)
        ? search.activityFirstAt
        : undefined,
    recordingAt:
      typeof search.recordingAt === "number" &&
      Number.isFinite(search.recordingAt)
        ? search.recordingAt
        : undefined,
    activityAt:
      typeof search.activityAt === "number" &&
      Number.isFinite(search.activityAt)
        ? search.activityAt
        : undefined,
  }),
  component: lazyRouteComponent(
    () => import("./pages/cameras/CameraRecording"),
  ),
});
const cameraViewRoute = createRoute({
  getParentRoute: () => camerasRoute,
  path: "$deviceId/$channel/view",
  staticData: { contentLayout: "viewport" },
  component: lazyRouteComponent(() => import("./pages/cameras/CameraView")),
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
      agentRoute,
      devicesRoute,
      membersRoute,
      addMemberRoute,
      camerasRoute.addChildren([
        camerasIndexRoute,
        cameraDetailRoute,
        cameraViewRoute,
        cameraRecordingRoute,
      ]),
      deviceLogsRoute,
      dataRoute,
      settingsRoute,
    ]),
    publicWorkspaceRoute.addChildren([imageAnalysisRoute]),
  ]),
  scrollRestoration: true,
  getScrollRestorationKey: (location) => location.href,
  defaultPreload: "intent",
  defaultViewTransition: {
    types: ({ fromLocation, toLocation }) => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        return false;
      const from = fromLocation?.pathname;
      const to = toLocation.pathname;
      const detail = /^\/cameras\/[^/]+\/[12](?:\/view)?\/?$/;
      return (from === "/cameras" && detail.test(to)) ||
        (from !== undefined &&
          detail.test(from) &&
          (to === "/cameras" || detail.test(to)))
        ? ["camera-expand"]
        : false;
    },
  },
});
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    contentLayout?: "viewport";
  }
  interface Register {
    router: typeof router;
  }
}
