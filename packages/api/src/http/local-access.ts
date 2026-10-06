import { AppError } from "../errors";
import { getConnInfo } from "hono/bun";
import { createMiddleware } from "hono/factory";
import { createLocalAccessCheck } from "./local-access-policy";

export function requireLocalAccess(
  ...args: Parameters<typeof createLocalAccessCheck>
) {
  const allowed = createLocalAccessCheck(...args);
  return createMiddleware(async (c, next) => {
    c.header("Cache-Control", "no-store");
    let address: string | undefined;
    try {
      address = getConnInfo(c).remote.address;
    } catch {
      throw new AppError("local_access_required");
    }
    if (!allowed(c.req.raw, address))
      throw new AppError("local_access_required");
    return await next();
  });
}
