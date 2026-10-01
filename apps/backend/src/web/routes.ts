import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { etag } from "hono/etag";

/** Static delivery only; API routes and streams never enter this router. */
export function createWebRoutes(root: string) {
  const options = {
    root,
    precompressed: true,
    onFound(_path, c) {
      c.header("Vary", "Accept-Encoding");
      c.header(
        "Cache-Control",
        /^\/assets\/[^/]+-[\w-]{8}\.[\w]+$/.test(c.req.path)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
    },
  } satisfies Parameters<typeof serveStatic>[0];
  return new Hono()
    .use(etag())
    .get("/*", serveStatic(options))
    .on(
      "GET",
      [
        "/",
        "/devices",
        "/cameras",
        "/cameras/:deviceId/:channel",
        "/settings",
        "/device-logs",
        "/data",
      ],
      serveStatic({ ...options, path: "index.html" }),
    );
}
