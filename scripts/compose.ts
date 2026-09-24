import { existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";

const desktopDocker = "/Applications/Docker.app/Contents/Resources/bin/docker";
const docker =
  Bun.which("docker") ?? (existsSync(desktopDocker) ? desktopDocker : null);
if (!docker) throw new Error("请安装 Docker 并启动 Docker 服务。");
const action = process.argv[2];
const service = process.argv[3];
if (action !== "up" && action !== "down")
  throw new Error("Expected up or down");
if (service !== undefined && service !== "db")
  throw new Error("Expected db or no service argument");
const child = Bun.spawn(
  [
    docker,
    "compose",
    ...(action === "up"
      ? ["up", "-d", "--wait", "--wait-timeout", "120"]
      : ["stop"]),
    ...(service ? [service] : []),
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
