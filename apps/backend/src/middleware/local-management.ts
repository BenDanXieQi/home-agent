import { AppError } from "@home-agent/api/errors";
import { createMiddleware } from "hono/factory";
import type { Environment } from "../environment";
import type { AppContext } from "../app-context";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Do not trust forwarded headers. Vite preserves the browser's Host header.
// JSON PUT requests need an explicit Origin check; hono/csrf only covers forms.
export function requireLocalManagementAccess(environment: Environment) {
  const allowedPorts = new Set([String(environment.BACKEND_PORT), "5173"]);
  const isAllowedManagementUrl = (url: URL) =>
    ["http:", "https:"].includes(url.protocol) &&
    loopbackHosts.has(url.hostname) &&
    allowedPorts.has(url.port || (url.protocol === "https:" ? "443" : "80")) &&
    !url.username &&
    !url.password;

  return createMiddleware<AppContext>(async (c, next) => {
    c.header("Cache-Control", "no-store");
    let isTrustedRequest = false;
    try {
      const requestUrl = new URL(c.req.url);
      const host = c.req.header("host");
      const hostUrl = new URL(`${requestUrl.protocol}//${host ?? ""}`);
      isTrustedRequest =
        Boolean(host) &&
        hostUrl.host === host?.toLowerCase() &&
        isAllowedManagementUrl(hostUrl);
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        const originUrl = new URL(origin);
        isTrustedRequest &&=
          originUrl.origin === origin && isAllowedManagementUrl(originUrl);
      }
    } catch {
      isTrustedRequest = false;
    }
    if (!isTrustedRequest) {
      throw new AppError("local_access_required");
    }
    return await next();
  });
}
