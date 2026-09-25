import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { parse } from "yaml";
import {
  applicationStatus,
  requireFreeApplicationPorts,
  devOwner,
  startDev,
  stopDev,
} from "./dev-runtime";
import {
  nativeRunning,
  requireFreePorts,
  root,
  runtime,
  startNative,
  stopNative,
} from "./go2rtc-runtime";

const desktopDocker = "/Applications/Docker.app/Contents/Resources/bin/docker";
const docker =
  Bun.which("docker") ?? (existsSync(desktopDocker) ? desktopDocker : null);
if (!docker) throw new Error("请安装 Docker 并启动 Docker 服务。");
const [action, ...args] = process.argv.slice(2);
const requestedMode =
  args.length === 2 && args[0] === "--mode" ? args[1] : undefined;
if (
  !["dev", "stop", "status"].includes(action ?? "") ||
  (args.length > 0 &&
    (action !== "dev" || !["native", "docker"].includes(requestedMode ?? "")))
)
  throw new Error(
    "用法：bun run dev [--mode native|docker]，bun run stop，bun run status",
  );
const env = {
  ...process.env,
  // oxlint-disable-next-line turbo/no-undeclared-env-vars
  PATH: `${dirname(docker)}${delimiter}${process.env.PATH ?? ""}`,
};
async function runDocker(arguments_: string[]) {
  const child = Bun.spawn([docker!, ...arguments_], {
    cwd: root,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await child.exited) throw new Error("Docker 命令失败，未完成模式切换。");
}
async function dockerRunning() {
  const child = Bun.spawn(
    [docker!, "compose", "ps", "--status", "running", "-q", "go2rtc"],
    { cwd: root, env, stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(child.stdout).text();
  if (await child.exited) throw new Error("无法检查 go2rtc 容器状态。");
  return output.trim().length > 0;
}
async function requireDockerNetwork() {
  if (process.platform !== "darwin") return;
  const settingsPath = resolve(
    homedir(),
    "Library/Group Containers/group.com.docker/settings-store.json",
  );
  let settings: { HostNetworkingEnabled?: boolean; KernelForUDP?: boolean };
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch {
    throw new Error(
      "无法读取本机 Docker Desktop 网络设置。请安装并启动 Docker Desktop，按 README.md 完成网络设置后重试。",
    );
  }
  if (settings.HostNetworkingEnabled !== true || settings.KernelForUDP !== true)
    throw new Error(
      "Docker 摄像头需要在 Settings → Resources → Network 同时开启 Enable host networking 和 Use kernel networking for UDP，然后 Apply & restart。每台 Mac 配置一次；启动脚本不会修改全局设置。详见 README.md。",
    );
}

async function selectedMode() {
  try {
    const mode = (
      await readFile(resolve(runtime, "go2rtc-mode"), "utf8")
    ).trim();
    if (mode !== "native" && mode !== "docker")
      throw new Error("运行模式无效，请用 dev --mode native|docker 选择。");
    return mode;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "docker";
    throw error;
  }
}
const modeLabel = (mode: string) =>
  mode === "native" ? "本机原生进程" : "Docker 容器";
async function runBun(commandArgs: string[]) {
  const child = Bun.spawn([process.execPath, ...commandArgs], {
    cwd: root,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await child.exited)
    throw new Error(`命令失败：bun ${commandArgs.join(" ")}`);
}
if (action === "status") {
  console.info(`已选 go2rtc 模式：${modeLabel(await selectedMode())}`);
  console.info(
    `开发应用：${(await devOwner()) ? "运行中" : "无受管理运行记录"}`,
  );
  await applicationStatus();
  console.info(`原生 go2rtc：${(await nativeRunning()) ? "运行中" : "未运行"}`);
  await runDocker(["compose", "ps", "-a"]);
  console.info("服务状态不代表摄像头已出帧。");
  process.exit(0);
}
let waitForDev: (() => Promise<number>) | undefined;
const up = ["compose", "up", "-d", "--wait", "--wait-timeout", "120"];
await mkdir(runtime, { recursive: true, mode: 0o700 });
const lock = resolve(runtime, "services.lock");
try {
  await mkdir(lock);
} catch {
  throw new Error(
    "已有启动或停止命令运行。若前次命令异常退出，请确认没有相关任务后删除 config/runtime/services.lock。",
  );
}
try {
  if (action === "stop") {
    await stopDev();
    await stopNative();
    await runDocker(["compose", "stop"]);
    console.info("本项目管理的开发应用、go2rtc 和数据库已停止，数据保留。");
  } else {
    const running = await devOwner();
    if (running && !requestedMode)
      throw new Error(
        "dev 已在运行；使用 dev --mode native|docker 切换模式，或先执行 bun run stop。",
      );
    if (!running) await requireFreeApplicationPorts();
    const modeFile = resolve(runtime, "go2rtc-mode");
    const mode = requestedMode ?? (await selectedMode());
    if (mode === "docker") await requireDockerNetwork();
    console.info(`go2rtc 运行方式：${modeLabel(mode)}；数据库：Docker 容器`);
    await runBun(["scripts/setup-local.ts"]);
    const configPath = resolve(root, "config/config.yaml");
    if (existsSync(configPath)) {
      const url = parse(await readFile(configPath, "utf8"))?.services?.go2rtc
        ?.url;
      if (url !== "http://127.0.0.1:1984")
        throw new Error(
          "本机部署统一使用 http://127.0.0.1:1984，请先在服务设置中更新 go2rtc 地址。",
        );
    }
    // Stop only this project's other mode. Unknown port owners are never killed.
    if (mode === "native") {
      if (await dockerRunning()) await runDocker(["compose", "stop", "go2rtc"]);
      if (!(await nativeRunning())) {
        await requireFreePorts();
        await startNative(runDocker);
      }
      const health = await fetch("http://127.0.0.1:1984/api", {
        signal: AbortSignal.timeout(3000),
      });
      await health.body?.cancel();
      if (!health.ok)
        throw new Error(
          "原生 go2rtc 健康检查失败，请检查 config/runtime/go2rtc.log。",
        );
    } else {
      await stopNative();
      if (!(await dockerRunning())) await requireFreePorts();
      await runDocker([...up, "--build", "--no-deps", "go2rtc"]);
      // Container health alone cannot prove Desktop host networking is enabled.
      let reachable = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const response = await fetch("http://127.0.0.1:1984/api", {
            signal: AbortSignal.timeout(1000),
          });
          await response.body?.cancel();
          if (response.ok) {
            reachable = true;
            break;
          }
        } catch {
          /* Wait for host-network listeners to become reachable. */
        }
        await Bun.sleep(500);
      }
      if (!reachable)
        throw new Error(
          "go2rtc 容器已启动，但本机无法访问 1984。Docker Desktop 请在 Settings → Resources → Network 开启 Enable host networking 并 Apply & restart；Linux 请检查 host 网络与端口占用。详见 README.md。",
        );
    }
    await runDocker([...up, "db"]);
    await writeFile(modeFile, mode + "\n", { mode: 0o600 });
    console.info(
      `go2rtc: ${mode} · http://127.0.0.1:1984（接口就绪不代表摄像头出帧）`,
    );
    if (running) console.info("go2rtc 模式已更新，现有开发应用继续运行。");
    else {
      await runBun(["run", "db:check"]);
      waitForDev = await startDev();
    }
  }
} finally {
  await rm(lock, { recursive: true });
}

if (waitForDev) process.exitCode = await waitForDev();
