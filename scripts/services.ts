import { startWebEntry, stopWebEntry, webEntryRunning } from "./web-entry";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import { parse } from "yaml";
import {
  applicationStatus,
  pendingApplications,
  devOwners,
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
  !["dev", "stop", "status", "initialize", "migrate"].includes(action ?? "") ||
  (args.length > 0 &&
    (action !== "dev" || !["native", "docker"].includes(requestedMode ?? "")))
)
  throw new Error(
    "用法：bun run dev [--mode native|docker]，bun run stop，bun run status，bun run db:init，bun run db:migrate",
  );
const env = {
  ...process.env,
  // oxlint-disable-next-line turbo/no-undeclared-env-vars
  PATH: `${dirname(docker)}${delimiter}${process.env.PATH ?? ""}`,
};
// oxlint-disable-next-line turbo/no-undeclared-env-vars
const localLangfuse = process.env.COMPOSE_PROFILES?.split(",").some(
  (profile) => profile.trim() === "langfuse",
);
async function prepareLangfuse() {
  if (!localLangfuse) return;
  // oxlint-disable-next-line turbo/no-undeclared-env-vars
  const secret = process.env["LANGFUSE_LOCAL_SECRET"];
  if (!secret || !/^[a-fA-F0-9]{64}$/.test(secret))
    throw new Error(
      "启用本地 Langfuse 需要 LANGFUSE_LOCAL_SECRET（openssl rand -hex 32）。",
    );
  const required = [
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LANGFUSE_INIT_USER_EMAIL",
    "LANGFUSE_INIT_USER_PASSWORD",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length)
    throw new Error(`启用本地 Langfuse 需要填写：${missing.join(", ")}`);
  await runDocker([
    "compose",
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "300",
    "--build",
    "langfuse-entry",
    "langfuse-worker",
  ]);
  console.info(
    `Langfuse：http://localhost:${process.env["LANGFUSE_PORT"] || "3001"}`,
  );
}
async function runDocker(arguments_: string[]) {
  const child = Bun.spawn([docker!, ...arguments_], {
    cwd: root,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await child.exited) throw new Error("Docker 命令失败，服务操作未完成。");
}
async function requireDocker() {
  const child = Bun.spawn([docker!, "info", "--format", "{{.ServerVersion}}"], {
    cwd: root,
    env,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 5000,
  });
  const error = await new Response(child.stderr).text();
  if ((await child.exited) === 0) return;

  if (process.platform === "darwin" && existsSync(desktopDocker)) {
    console.info("等待 Docker Desktop 启动，最多 120 秒……");
    await runDocker(["desktop", "start", "--timeout", "120"]);
    await runDocker(["info", "--format", "Docker {{.ServerVersion}} 已就绪"]);
    return;
  }

  throw new Error(`Docker 引擎未就绪，请启动 Docker 服务后重试。\n${error}`);
}
async function dockerRunning(service: "go2rtc" | "db") {
  const child = Bun.spawn(
    [docker!, "compose", "ps", "--status", "running", "-q", service],
    { cwd: root, env, stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(child.stdout).text();
  if (await child.exited) throw new Error(`无法检查 ${service} 容器状态。`);
  return output.trim().length > 0;
}
async function waitForGo2rtc() {
  let cause: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:1984/api", {
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.ok) return { ready: true as const };
      cause = new Error(`go2rtc HTTP ${response.status}`);
    } catch (error) {
      cause = error;
    }
    await Bun.sleep(500);
  }
  return { ready: false as const, cause };
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
async function prepareDatabase() {
  await runDocker([...up, "db", "agent-mysql"]);
  await runBun(["run", "--cwd", "apps/backend", "db:migrate"]);
  await runBun(["run", "--cwd", "apps/backend", "db:check"]);
}
if (action === "status") {
  console.info(`已选 go2rtc 模式：${modeLabel(await selectedMode())}`);
  console.info(
    `开发应用：${(await devOwners()).length > 0 ? "运行中" : "无受管理运行记录"}`,
  );
  await applicationStatus();
  console.info(
    `HTTPS 入口：https://localhost:8443 · ${(await webEntryRunning()) ? "运行中" : "未运行"}`,
  );
  console.info(`原生 go2rtc：${(await nativeRunning()) ? "运行中" : "未运行"}`);
  await runDocker(["compose", "--profile", "langfuse", "ps", "-a"]);
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
    "已有服务管理命令运行。若前次命令异常退出，请确认没有相关任务后删除 config/runtime/services.lock。",
  );
}
try {
  if (action === "stop") {
    await stopDev();
    await stopWebEntry();
    await stopNative();
    await runDocker(["compose", "--profile", "langfuse", "stop"]);
    console.info("本项目管理的开发应用及 Docker 依赖已停止，数据保留。");
  } else if (action === "initialize" || action === "migrate") {
    await requireDocker();
    await runBun(["scripts/setup-local.ts"]);
    await prepareDatabase();
  } else {
    const modeFile = resolve(runtime, "go2rtc-mode");
    const mode = requestedMode ?? (await selectedMode());
    await requireDocker();
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
    if (mode === "native") {
      if (await dockerRunning("go2rtc"))
        await runDocker(["compose", "stop", "go2rtc"]);
      if (!(await nativeRunning())) {
        await requireFreePorts();
        await startNative(runDocker);
      } else console.info("原生 go2rtc 已运行，跳过启动。");
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
      if (await dockerRunning("go2rtc"))
        console.info("go2rtc 容器已运行，跳过启动。");
      else {
        await requireFreePorts();
        await runDocker([...up, "--build", "--no-deps", "go2rtc"]);
      }
      let health = await waitForGo2rtc();
      if (!health.ready && process.platform === "darwin") {
        console.info("go2rtc 本机端口不可达，重启本项目 go2rtc 容器后重试……");
        await runDocker(["compose", "restart", "--no-deps", "go2rtc"]);
        health = await waitForGo2rtc();
      }
      if (!health.ready)
        throw new Error(
          "go2rtc 容器已启动，但本机仍无法访问 1984。macOS 请确认 Docker Desktop 的 Settings → Resources → Network 已开启 Enable host networking 并应用；Linux 请检查 host 网络与端口占用。详见 docs/running.md。",
          { cause: health.cause },
        );
    }
    await prepareDatabase();
    await prepareLangfuse();
    await runBun(["run", "--cwd", "apps/agent", "prompts:init"]);
    await writeFile(modeFile, mode + "\n", { mode: 0o600 });
    console.info(
      `go2rtc: ${mode} · http://127.0.0.1:1984（接口就绪不代表摄像头出帧）`,
    );
    await startWebEntry("development");
    const pending = await pendingApplications();
    if (pending.length > 0) {
      waitForDev = await startDev(pending);
    } else console.info("所有开发应用均已启动，无需启动新进程。");
  }
} finally {
  await rm(lock, { recursive: true });
}

if (waitForDev) process.exitCode = await waitForDev();
