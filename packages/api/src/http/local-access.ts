import { AppError } from "../errors";
import { isIP } from "node:net";
import { getConnInfo } from "hono/bun";
import { createMiddleware } from "hono/factory";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackAddress(address: string | undefined) {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  if (isIP(normalized) !== 6) return false;
  const canonical = new URL(`http://[${normalized}]`).hostname;
  return (
    canonical === "[::1]" ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(canonical)
  );
}

// Do not trust forwarded headers. Vite preserves the browser's Host header.
// JSON PUT requests need an explicit Origin check; hono/csrf only covers forms.
export function requireLocalAccess(ports: readonly number[]) {
  const allowedPorts = new Set(ports.map(String));
  const isAllowedManagementUrl = (url: URL) =>
    ["http:", "https:"].includes(url.protocol) &&
    loopbackHosts.has(url.hostname) &&
    allowedPorts.has(url.port || (url.protocol === "https:" ? "443" : "80")) &&
    !url.username &&
    !url.password;

  return createMiddleware(async (c, next) => {
    c.header("Cache-Control", "no-store");
    let isTrustedRequest = false;
    try {
      const requestUrl = new URL(c.req.url);
      const host = c.req.header("host");
      const hostUrl = new URL(`${requestUrl.protocol}//${host ?? ""}`);
      isTrustedRequest =
        isLoopbackAddress(getConnInfo(c).remote.address) &&
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
