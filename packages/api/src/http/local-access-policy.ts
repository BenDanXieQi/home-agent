import { isIP } from "node:net";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const webEntry = new URL("https://localhost:8443");

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

// Do not trust forwarded headers. Both local proxies preserve Host and Origin.
// JSON PUT requests need an explicit Origin check; hono/csrf only covers forms.
export function createLocalAccessCheck(
  ports: readonly number[],
  options: { webEntry?: boolean } = {},
) {
  const allowedPorts = new Set(ports.map(String));
  const isAllowedManagementUrl = (url: URL) =>
    ["http:", "https:"].includes(url.protocol) &&
    loopbackHosts.has(url.hostname) &&
    allowedPorts.has(url.port || (url.protocol === "https:" ? "443" : "80")) &&
    !url.username &&
    !url.password;

  return (request: Request, address: string | undefined) => {
    let isTrustedRequest = false;
    try {
      const requestUrl = new URL(request.url);
      const host = request.headers.get("host");
      const hostUrl = new URL(`${requestUrl.protocol}//${host ?? ""}`);
      isTrustedRequest =
        isLoopbackAddress(address) &&
        Boolean(host) &&
        hostUrl.host === host?.toLowerCase() &&
        (isAllowedManagementUrl(hostUrl) ||
          (options.webEntry === true && hostUrl.host === webEntry.host));
      const origin = request.headers.get("origin");
      if (origin !== null) {
        const originUrl = new URL(origin);
        isTrustedRequest &&=
          originUrl.origin === origin &&
          (isAllowedManagementUrl(originUrl) ||
            (options.webEntry === true && origin === webEntry.origin));
      }
    } catch {
      isTrustedRequest = false;
    }
    return isTrustedRequest;
  };
}
