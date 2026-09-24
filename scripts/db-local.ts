import { existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";

const desktopDocker = "/Applications/Docker.app/Contents/Resources/bin/docker";
const docker =
  Bun.which("docker") ?? (existsSync(desktopDocker) ? desktopDocker : null);
if (!docker)
  throw new Error("Install and start Docker before running db:up/db:down");
const action = process.argv[2];
if (action !== "up" && action !== "down")
  throw new Error("Expected up or down");
const child = Bun.spawn(
  [
    docker,
    "compose",
    ...(action === "up" ? ["up", "-d", "--wait", "db"] : ["down"]),
  ],
  {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      // This root command runs directly, outside Turbo's task environment.
      // oxlint-disable-next-line turbo/no-undeclared-env-vars
      PATH: `${dirname(docker)}${delimiter}${process.env.PATH ?? ""}`,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
